package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Regression guard for #7653: `issue list --output json` must always emit
// valid JSON. Descriptions can contain newlines, tabs and other control
// characters; the CLI decodes the server response and re-encodes it through
// encoding/json (cli.PrintJSON), which escapes those characters. The existing
// list-json test only asserts the command returns no error, not that its
// stdout parses — this pins the stronger contract.

func TestIssueListJSONEscapesControlCharsInDescription(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/issues" {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"issues": []any{map[string]any{
				"id": "issue-1", "identifier": "MUL-1", "title": "t",
				"status": "todo", "priority": "none",
				"description": "line1\nline2\twith tab\rand CR",
			}},
			"total": 1,
		})
	}))
	defer srv.Close()

	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "test-token")

	cmd := newIssueListTestCmd()
	_ = cmd.Flags().Set("output", "json")
	out, err := captureStdout(t, func() error { return runIssueList(cmd, nil) })
	if err != nil {
		t.Fatalf("runIssueList: %v", err)
	}

	var parsed struct {
		Issues []struct {
			Description string `json:"description"`
		} `json:"issues"`
	}
	if uerr := json.Unmarshal([]byte(out), &parsed); uerr != nil {
		t.Fatalf("output is not valid JSON: %v\n---\n%s", uerr, out)
	}
	// A raw newline inside a JSON string is the exact defect from #7653.
	if strings.Contains(out, "line1\nline2") {
		t.Fatalf("stdout contains an unescaped control character:\n%s", out)
	}
	if len(parsed.Issues) != 1 || parsed.Issues[0].Description != "line1\nline2\twith tab\rand CR" {
		t.Fatalf("description did not round-trip: %+v", parsed.Issues)
	}
}

// If the server itself sends a body with a raw control character inside a
// string (invalid JSON on the wire), the CLI must fail cleanly rather than
// forward invalid JSON to stdout.
func TestIssueListJSONNeverForwardsInvalidServerJSON(t *testing.T) {
	rawBody := "{\"issues\":[{\"id\":\"issue-1\",\"identifier\":\"MUL-1\",\"title\":\"t\",\"status\":\"todo\",\"priority\":\"none\",\"description\":\"line1\nline2\"}],\"total\":1}"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/issues" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(rawBody))
	}))
	defer srv.Close()

	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "test-token")

	cmd := newIssueListTestCmd()
	_ = cmd.Flags().Set("output", "json")
	out, err := captureStdout(t, func() error { return runIssueList(cmd, nil) })
	if err == nil && out == "" {
		t.Fatal("expected either an error or output, got neither")
	}
	if out != "" {
		var parsed any
		if uerr := json.Unmarshal([]byte(out), &parsed); uerr != nil {
			t.Fatalf("CLI forwarded invalid JSON to stdout: %v\n---\n%s", uerr, out)
		}
	}
}
