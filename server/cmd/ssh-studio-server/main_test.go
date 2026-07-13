package main

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestSessionRequiresHelloAndShutsDown(t *testing.T) {
	frame := func(payload string) string {
		return fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(payload), payload)
	}
	input := strings.NewReader(
		frame(`{"jsonrpc":"2.0","id":1,"method":"system/ping"}`) +
			frame(`{"jsonrpc":"2.0","id":2,"method":"system/hello"}`) +
			frame(`{"jsonrpc":"2.0","id":3,"method":"system/shutdown"}`),
	)
	output := new(bytes.Buffer)

	if err := runSession(context.Background(), input, output); err != nil {
		t.Fatal(err)
	}
	got := output.String()
	if !strings.Contains(got, "HandshakeRequired") || !strings.Contains(got, "serverVersion") || !strings.Contains(got, `"id":3`) {
		t.Fatalf("unexpected session output: %s", got)
	}
}
