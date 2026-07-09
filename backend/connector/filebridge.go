package connector

import "context"

// FileBridge is the reverse channel to the desktop (design §2, option A). A
// LOCAL-file tool runs inside the cloud loop but the file lives on the client, so
// its Invoke asks the desktop (over the SSE stream) to do the read/write behind
// fsguard, and blocks for the result. This is a DIFFERENT security regime from
// enterprise data: local files are the user's own, gated by fsguard + user
// confirmation on the client, NOT by OpenFGA.
type FileBridge interface {
	// RequestFile asks the client to perform op ("read"|"write") on path.
	// contents is the payload for writes. Returns the file contents (read) or a
	// confirmation string (write). Blocks until the client responds or ctx is done.
	RequestFile(ctx context.Context, op, path, contents string) (string, error)
}

type bridgeKey struct{}

// WithFileBridge attaches a per-request bridge to the context (set by agentd
// before a turn). Local-file tools read it back via FileBridgeFrom.
func WithFileBridge(ctx context.Context, b FileBridge) context.Context {
	return context.WithValue(ctx, bridgeKey{}, b)
}

// FileBridgeFrom returns the bridge on the context, or nil if none (e.g. a
// non-desktop caller) — local-file tools then report they're unavailable.
func FileBridgeFrom(ctx context.Context) FileBridge {
	b, _ := ctx.Value(bridgeKey{}).(FileBridge)
	return b
}
