package agent

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// zeroclawBlockedArgs are flags hardcoded by the daemon that must not be
// overridden by user-configured custom_args. `acp` is the protocol
// subcommand that drives the ACP JSON-RPC transport; overriding it would
// break the daemon↔ZeroClaw communication contract. `--help`/`-h` and the
// login/auth flags would switch the CLI into a mode that never starts the
// ACP server.
var zeroclawBlockedArgs = map[string]blockedArgMode{
	"acp":     blockedStandalone,
	"--help":  blockedStandalone,
	"-h":      blockedStandalone,
	"login":   blockedStandalone,
	"--login": blockedStandalone,
	"--auth":  blockedStandalone,
}

// zeroclawBackend implements Backend by spawning `zeroclaw acp` and
// communicating via the standard ACP (Agent Client Protocol) JSON-RPC 2.0
// transport over stdin/stdout.
//
// ZeroClaw is a Rust-based, single-binary generic agent runtime (see
// multica-ai/multica#1543). Its ACP server exposes the same protocol
// surface that Hermes/Kimi/Reasonix/Dim/Traecli/Grok/QwenPaw/MCode use, so
// the backend reuses the shared hermesClient ACP transport — only the
// binary, the session bootstrap, and the tool-name extraction differ.
//
// This backend targets the vanilla ACP handshake (initialize → session/new
// or session/load → session/prompt) with no provider-specific quirks
// layered on top: no permission-preset injection, no version gate, and no
// separate authenticate step. Those were verified against real binaries for
// Dim and Grok respectively; ZeroClaw has not yet had the same hands-on
// verification, so this file deliberately does not guess at behavior it
// cannot confirm. If a real ZeroClaw binary turns out to need one of those
// (e.g. a hardcoded restrictive permission preset like Dim's), add it here
// following the Dim/Grok pattern once verified.
type zeroclawBackend struct {
	cfg Config
}

var (
	zeroclawReaderDrainGrace      = 2 * time.Second
	zeroclawNotificationQuietTime = 250 * time.Millisecond
)

// zeroclawMessageStream serializes sends and the final close so a late
// stdout reader cannot send on a closed channel. Mirrors dim/grok/traecli.
type zeroclawMessageStream struct {
	ch     chan Message
	mu     sync.Mutex
	closed bool
}

func newZeroclawMessageStream(size int) *zeroclawMessageStream {
	return &zeroclawMessageStream{ch: make(chan Message, size)}
}

func (s *zeroclawMessageStream) send(msg Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	trySend(s.ch, msg)
}

func (s *zeroclawMessageStream) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	close(s.ch)
}

func (b *zeroclawBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
	execPath := b.cfg.ExecutablePath
	if execPath == "" {
		execPath = "zeroclaw"
	}
	if _, err := exec.LookPath(execPath); err != nil {
		return nil, fmt.Errorf("zeroclaw executable not found at %q: %w", execPath, err)
	}

	// Translate the agent's mcp_config (Claude-style object of objects) into
	// the array shape ACP session/new and session/load expect. Fail closed on
	// malformed JSON so the launch surfaces the real error instead of silently
	// dropping every MCP server.
	mcpServers, err := buildACPMcpServers(opts.McpConfig, b.cfg.Logger)
	if err != nil {
		return nil, fmt.Errorf("zeroclaw: invalid mcp_config: %w", err)
	}

	timeout := opts.Timeout
	runCtx, cancel := runContext(ctx, timeout)

	zeroclawArgs := append([]string{"acp"}, filterCustomArgs(opts.CustomArgs, zeroclawBlockedArgs, b.cfg.Logger)...)

	cmd := b.cfg.commandAt(execPath).exec(runCtx, zeroclawArgs...)
	hideAgentWindow(cmd)
	b.cfg.logAgentCommand(cmd, newAgentCommandLogArgs(zeroclawArgs, trustAgentCommandPositional(0, "acp")))
	if opts.Cwd != "" {
		cmd.Dir = opts.Cwd
	}
	cmd.Env = buildEnv(b.cfg.Env)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("zeroclaw stdout pipe: %w", err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("zeroclaw stdin pipe: %w", err)
	}
	// StderrPipe + an explicit copier give us a join point (`stderrDone`) that
	// fires before the failure-promotion decision; see hermes.go for why the
	// io.MultiWriter form races with stopReason=end_turn under load.
	providerErr := newACPProviderErrorSniffer("zeroclaw")
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("zeroclaw stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start zeroclaw: %w", err)
	}

	stderrSink := io.MultiWriter(newLogWriter(b.cfg.Logger, "[zeroclaw:stderr] "), providerErr)
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		_, _ = io.Copy(stderrSink, stderr)
	}()

	b.cfg.Logger.Info("zeroclaw acp started", "pid", cmd.Process.Pid, "cwd", opts.Cwd)

	msgStream := newZeroclawMessageStream(256)
	resCh := make(chan Result, 1)

	// ZeroClaw streams interim narration and the final answer as the same
	// agent_message_chunk type; the tracker keeps only the post-tool-call
	// block for Result.Output while retaining the full text for error
	// detection.
	var deliverable acpDeliverableTracker

	promptDone := make(chan hermesPromptResult, 1)
	activity := make(chan struct{}, 1)

	c := &hermesClient{
		cfg:          b.cfg,
		stdin:        stdin,
		pending:      make(map[int]*pendingRPC),
		pendingTools: make(map[string]*pendingToolCall),
		onActivity: func() {
			select {
			case activity <- struct{}{}:
			default:
			}
		},
		onMessage: func(msg Message) {
			if msg.Type == MessageToolUse {
				// Re-normalise tool titles the same way kimi/traecli/grok/dim
				// do so the UI sees consistent snake_case names.
				msg.Tool = kimiToolNameFromTitle(msg.Tool)
			}
			deliverable.observe(msg)
			msgStream.send(msg)
		},
		onPromptDone: func(result hermesPromptResult) {
			select {
			case promptDone <- result:
			default:
			}
		},
	}

	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		scanner := newAgentStreamScanner(stdout)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			c.handleLine(line)
		}
		c.closeAllPending(fmt.Errorf("zeroclaw process exited"))
	}()

	go func() {
		defer cancel()
		defer msgStream.close()
		defer close(resCh)
		defer func() {
			stdin.Close()
			_ = cmd.Wait()
		}()

		startTime := time.Now()
		finalStatus := "completed"
		var finalError string
		var sessionID string
		// Set when the ACP runtime refuses the session we asked to
		// resume. Only that is curable by starting a fresh session, so
		// handshake/network failures below must leave it false.
		var resumeRejected bool
		effectiveModel := strings.TrimSpace(opts.Model)

		initResult, err := c.request(runCtx, "initialize", map[string]any{
			"protocolVersion": 1,
			"clientInfo": map[string]any{
				"name":    "multica-agent-sdk",
				"version": "0.2.0",
			},
			"clientCapabilities": map[string]any{},
		})
		if err != nil {
			finalStatus = "failed"
			finalError = fmt.Sprintf("zeroclaw initialize failed: %v", err)
			resCh <- Result{Status: finalStatus, Error: finalError, DurationMs: time.Since(startTime).Milliseconds()}
			return
		}

		// Drop MCP entries whose remote transport the runtime didn't advertise.
		// See hermes.go for why sending an unsupported transport tanks session/new.
		mcpServers = filterACPMcpServersByCapability(mcpServers, extractACPMcpCapabilities(initResult), "zeroclaw", b.cfg)

		cwd := opts.Cwd
		if cwd == "" {
			cwd = "."
		}

		if opts.ResumeSessionID != "" {
			result, err := c.request(runCtx, "session/load", map[string]any{
				"cwd":        cwd,
				"sessionId":  opts.ResumeSessionID,
				"mcpServers": mcpServers,
			})
			if err != nil {
				if isACPSessionNotFound(err) {
					b.cfg.Logger.Warn("zeroclaw resumed session not found; the daemon will retry fresh",
						"backend", "zeroclaw",
						"requested_session", opts.ResumeSessionID,
					)
					resumeRejected = true
					resCh <- Result{Status: "failed", Error: fmt.Sprintf("zeroclaw session/load failed: %v", err), DurationMs: time.Since(startTime).Milliseconds(), ResumeRejected: resumeRejected}
					return
				}
				finalStatus = "failed"
				finalError = fmt.Sprintf("zeroclaw session/load failed: %v", err)
				resCh <- Result{Status: finalStatus, Error: finalError, DurationMs: time.Since(startTime).Milliseconds(), ResumeRejected: resumeRejected}
				return
			}
			var changed bool
			sessionID, changed = resolveResumedSessionID(opts.ResumeSessionID, result)
			if changed {
				b.cfg.Logger.Warn("zeroclaw returned a different session id on resume — original was likely lost; continuing with the new id",
					"backend", "zeroclaw",
					"requested", opts.ResumeSessionID,
					"actual", sessionID,
				)
			}
			if effectiveModel == "" {
				effectiveModel = extractACPCurrentModelID(result)
			}
		} else {
			result, err := c.request(runCtx, "session/new", map[string]any{
				"cwd":        cwd,
				"mcpServers": mcpServers,
			})
			if err != nil {
				if runCtx.Err() == context.DeadlineExceeded {
					finalStatus = "timeout"
					finalError = fmt.Sprintf("zeroclaw timed out during session/new: %v", timeout)
				} else if runCtx.Err() == context.Canceled {
					finalStatus = "aborted"
					finalError = fmt.Sprintf("zeroclaw aborted: %v", err)
				} else {
					finalStatus = "failed"
					finalError = fmt.Sprintf("zeroclaw session/new failed: %v", err)
				}
				resCh <- Result{Status: finalStatus, Error: finalError, DurationMs: time.Since(startTime).Milliseconds()}
				return
			}
			sessionID = extractACPSessionID(result)
			if sessionID == "" {
				finalStatus = "failed"
				finalError = "zeroclaw session/new returned no session ID"
				resCh <- Result{Status: finalStatus, Error: finalError, DurationMs: time.Since(startTime).Milliseconds()}
				return
			}
			if effectiveModel == "" {
				effectiveModel = extractACPCurrentModelID(result)
			}
		}

		c.sessionID = sessionID
		// Early session pin so a cancelled run still preserves resume pointer.
		msgStream.send(Message{Type: MessageStatus, Status: "running", SessionID: sessionID})
		b.cfg.Logger.Info("zeroclaw session ready", "session_id", sessionID)

		if opts.Model != "" {
			if _, err := c.request(runCtx, "session/set_model", map[string]any{
				"sessionId": sessionID,
				"modelId":   opts.Model,
			}); err != nil {
				b.cfg.Logger.Warn("zeroclaw set_session_model failed", "error", err, "requested_model", opts.Model)
				finalStatus = "failed"
				finalError = fmt.Sprintf("zeroclaw could not switch to model %q: %v", opts.Model, err)
				if opts.ResumeSessionID != "" && isACPSessionNotFound(err) {
					b.cfg.Logger.Warn("resumed session not found at set_model time; clearing session id so the daemon retries fresh",
						"backend", "zeroclaw",
						"session_id", sessionID,
					)
					sessionID = ""
					resumeRejected = true
				}
				resCh <- Result{
					Status:         finalStatus,
					Error:          finalError,
					DurationMs:     time.Since(startTime).Milliseconds(),
					SessionID:      sessionID,
					ResumeRejected: resumeRejected,
				}
				return
			}
			b.cfg.Logger.Info("zeroclaw session model set", "model", opts.Model)
		}

		userText := prompt
		if opts.SystemPrompt != "" {
			userText = opts.SystemPrompt + "\n\n---\n\n" + prompt
		}

		_, err = c.request(runCtx, "session/prompt", map[string]any{
			"sessionId": sessionID,
			"prompt": []map[string]any{
				{"type": "text", "text": userText},
			},
		})
		if err != nil {
			if runCtx.Err() == context.DeadlineExceeded {
				finalStatus = "timeout"
				finalError = fmt.Sprintf("zeroclaw timed out after %s", timeout)
			} else if runCtx.Err() == context.Canceled {
				finalStatus = "aborted"
				finalError = "execution cancelled"
			} else {
				finalStatus = "failed"
				finalError = fmt.Sprintf("zeroclaw session/prompt failed: %v", err)
				if opts.ResumeSessionID != "" && isACPSessionNotFound(err) {
					b.cfg.Logger.Warn("resumed session not found at prompt time; clearing session id so the daemon retries fresh",
						"backend", "zeroclaw",
						"session_id", sessionID,
					)
					sessionID = ""
					resumeRejected = true
				}
			}
		} else {
			select {
			case pr := <-promptDone:
				if pr.stopReason == "cancelled" {
					finalStatus = "aborted"
					finalError = "zeroclaw cancelled the prompt"
				}
				if effectiveModel == "" {
					effectiveModel = pr.modelID
				}
				c.mergeUsage(pr.usage)
			default:
			}
			// Give the stdout reader a bounded chance to consume notifications
			// zeroclaw may emit just after session/prompt returns
			// (agent_message_chunk, usage updates). Closing stdin at the
			// response boundary otherwise races the reader and truncates the
			// final text — the same race fixed for hermes/dim/grok.
			waitForACPNotificationQuiescence(runCtx, activity, readerDone, zeroclawNotificationQuietTime, zeroclawReaderDrainGrace)
		}

		duration := time.Since(startTime)
		b.cfg.Logger.Info("zeroclaw finished", "pid", cmd.Process.Pid, "status", finalStatus, "duration", duration.Round(time.Millisecond).String())

		stdin.Close()
		cancel()

		// ZeroClaw's ACP server may keep the process — and the stdout/stderr
		// pipes — open briefly after session/prompt returns. Bound the drain.
		drainCtx, drainCancel := context.WithTimeout(context.Background(), zeroclawReaderDrainGrace)
		select {
		case <-readerDone:
		case <-drainCtx.Done():
		}
		select {
		case <-stderrDone:
		case <-drainCtx.Done():
		}
		drainCancel()

		finalOutput, providerErrorOutput := deliverable.result()

		// Promote completed→failed when stderr or the agent text stream show a
		// terminal upstream-LLM failure (auth / rate-limit / HTTP 4xx). It reads
		// the full text stream, not the deliverable, so a give-up turn that
		// lands before a tool call stays visible.
		finalStatus, finalError = promoteACPResultOnProviderError(finalStatus, finalError, providerErrorOutput, providerErr)

		u := c.accumulatedUsage()

		var usageMap map[string]TokenUsage
		if acpUsagePresent(u) {
			model := effectiveModel
			if model == "" {
				model = "unknown"
			}
			usageMap = map[string]TokenUsage{model: u}
		}

		resCh <- Result{
			Status:         finalStatus,
			Output:         finalOutput,
			Error:          finalError,
			DurationMs:     duration.Milliseconds(),
			SessionID:      sessionID,
			ResumeRejected: resumeRejected,
			Usage:          usageMap,
		}
	}()

	return &Session{Messages: msgStream.ch, Result: resCh}, nil
}
