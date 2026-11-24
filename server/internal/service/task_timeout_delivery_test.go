package service

import (
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/protocol"
	"github.com/multica-ai/multica/server/pkg/taskfailure"
)

func TestReportedTaskTimeoutFreesAgentSlotAndRejectsLateCompletion(t *testing.T) {
	f := newClaimDecisionFixture(t, 1)
	ctx := t.Context()

	timedOutID := f.fx.Task(t, util.UUIDToString(f.agentID), testutil.Cols{
		"runtime_id":   util.UUIDToString(f.runtimeID),
		"issue_id":     f.issueID,
		"status":       "running",
		"started_at":   testutil.Raw("now()"),
		"attempt":      1,
		"max_attempts": 1,
	})
	waitingIssue := f.fx.Issue(t, "next issue for the same agent")
	waitingID := f.fx.Task(t, util.UUIDToString(f.agentID), testutil.Cols{
		"runtime_id": util.UUIDToString(f.runtimeID),
		"issue_id":   waitingIssue,
		"status":     "queued",
	})
	claimed, err := f.svc.ClaimTaskForRuntime(ctx, f.runtimeID)
	if err != nil || claimed != nil {
		t.Fatalf("claim before timeout = %+v, %v, want no available slot", claimed, err)
	}

	timeout := taskfailure.ReasonTimeout.String()
	taskID := util.MustParseUUID(timedOutID)
	terminal, transitioned, err := f.svc.FailTaskWithTransition(ctx, taskID, protocol.TaskFailRequest{
		Error: "Agent timed out after 48h", FailureReason: timeout,
	})
	if err != nil || !transitioned || terminal.Status != "failed" || terminal.FailureReason.String != timeout {
		t.Fatalf("timeout terminal state=%+v transitioned=%v err=%v", terminal, transitioned, err)
	}
	f.svc.NotifyTaskFinished(*terminal)

	claimed, err = f.svc.ClaimTaskForRuntime(ctx, f.runtimeID)
	if err != nil || claimed == nil || util.UUIDToString(claimed.ID) != waitingID {
		t.Fatalf("claim after timeout=%+v err=%v, want %s", claimed, err, waitingID)
	}

	late, transitioned, err := f.svc.CompleteTaskWithTransition(ctx, taskID, []byte(`{"output":"Late final answer."}`), "", "", "", false, "", "")
	if err != nil || transitioned || late.Status != "failed" || late.FailureReason.String != timeout {
		t.Fatalf("late completion=%+v transitioned=%v err=%v, want failed timeout", late, transitioned, err)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM comment WHERE source_task_id=$1 AND content=$2", taskID, "Late final answer."); n != 0 {
		t.Fatalf("late completion produced %d result comments, want 0", n)
	}
}
