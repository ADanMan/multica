package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/spf13/cobra"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestDoctorChecksAreIndependent(t *testing.T) {
	redirectTestHome(t, t.TempDir())
	t.Setenv("MULTICA_HERMES_PATH", "/does-not-exist/hermes")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" || r.Header.Get("Authorization") != "" || r.URL.RawQuery != "" {
			t.Errorf("unexpected health request")
		}
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()
	cmd := &cobra.Command{}
	cmd.SetContext(context.Background())
	cmd.Flags().String("output", "json", "")
	cmd.Flags().String("profile", "unknown-fixture-profile", "")
	cmd.Flags().String("tool", "hermes", "")
	cmd.Flags().String("server-url", "", "")
	if err := cmd.Flags().Set("server-url", srv.URL); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MULTICA_TOKEN", "fixture-credential")
	var out bytes.Buffer
	cmd.SetOut(&out)
	if err := runDoctor(cmd, nil); err != errSilent {
		t.Fatalf("error = %v", err)
	}
	var checks []setupCheck
	if err := json.Unmarshal(out.Bytes(), &checks); err != nil {
		t.Fatal(err)
	}
	if len(checks) != 3 || !checks[0].OK || checks[1].OK || checks[2].OK {
		t.Fatalf("checks: %+v", checks)
	}
	if bytes.Contains(out.Bytes(), []byte("fixture-credential")) {
		t.Fatal("output contains credentials")
	}
	srv.Close()
	if row := checkDoctorServer(context.Background(), srv.URL); row.OK || row.Message == "" {
		t.Fatalf("unreachable server: %+v", row)
	}
}

func TestDoctorRejectsLoginPage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("<html>sign in</html>")) }))
	defer srv.Close()
	if row := checkDoctorServer(context.Background(), srv.URL); row.OK {
		t.Fatal("login page was reported as a healthy server")
	}
}

func TestDoctorRecognizesSelectedDaemon(t *testing.T) {
	redirectTestHome(t, t.TempDir())
	const profile = "doctor-test"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "running", "profile": profile, "pid": os.Getpid()})
	}))
	defer srv.Close()
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	if err := publishDaemonPort(profile, daemonPortRecord{Port: port, PID: os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	if row := checkDoctorDaemon(context.Background(), profile); !row.OK {
		t.Fatalf("running profile: %+v", row)
	}
}

func TestDoctorReportsStoppedKnownProfile(t *testing.T) {
	redirectTestHome(t, t.TempDir())
	for i := 0; i < 100; i++ {
		profile := fmt.Sprintf("doctor-stopped-%d", i)
		l, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", healthPortForProfile(profile)))
		if err != nil {
			continue
		}
		// An inert local endpoint makes a stopped daemon deterministic even when
		// an unrelated daemon is already running on the developer's machine.
		srv := &http.Server{Handler: http.NotFoundHandler()}
		go srv.Serve(l)
		defer srv.Close()
		if err := os.MkdirAll(daemonDirForProfile(profile), 0700); err != nil {
			t.Fatal(err)
		}
		row := checkDoctorDaemon(context.Background(), profile)
		if row.OK || row.Message != "Start the selected profile with multica daemon start." {
			t.Fatalf("stopped profile: %+v", row)
		}
		return
	}
	t.Fatal("could not allocate a profile health fixture")
}
