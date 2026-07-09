// Package localfile exposes the user's local files as AMBIENT tools (design §2,
// M4b). Unlike enterprise connectors, these run on the CLIENT: Invoke asks the
// desktop (via the FileBridge on the context) to read/write behind fsguard +
// user confirmation. They are NOT skill-gated or OpenFGA-guarded — local files
// are the user's own; the security regime is the client-side path jail + confirm.
package localfile

import (
	"context"
	"fmt"

	"github.com/merchantagent/backend/connector"
)

// Tools returns the ambient local-file tools.
func Tools() []connector.Tool { return []connector.Tool{readTool{}, writeTool{}} }

type readTool struct{}

func (readTool) Spec() connector.ToolSpec {
	return connector.ToolSpec{
		Name:        "read_local_file",
		Description: "读取用户本机工作区内的文件内容（相对路径，受沙箱限制）。用于用户让你处理其本地文件时。",
		Params:      []connector.ParamSpec{{Name: "path", Description: "工作区内相对路径", Required: true}},
	}
}
func (readTool) Invoke(ctx context.Context, args map[string]any) (map[string]any, error) {
	br := connector.FileBridgeFrom(ctx)
	if br == nil {
		return nil, fmt.Errorf("本地文件不可用（非桌面会话）")
	}
	path, _ := args["path"].(string)
	if path == "" {
		return nil, fmt.Errorf("missing path")
	}
	content, err := br.RequestFile(ctx, "read", path, "")
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "content": content}, nil
}

type writeTool struct{}

func (writeTool) Spec() connector.ToolSpec {
	return connector.ToolSpec{
		Name:        "write_local_file",
		Description: "把内容写入用户本机工作区内的文件（相对路径）。覆盖已存在文件需用户在客户端确认。用于产出整理好的文件。",
		Params: []connector.ParamSpec{
			{Name: "path", Description: "工作区内相对路径", Required: true},
			{Name: "content", Description: "要写入的文本内容", Required: true},
		},
	}
}
func (writeTool) Invoke(ctx context.Context, args map[string]any) (map[string]any, error) {
	br := connector.FileBridgeFrom(ctx)
	if br == nil {
		return nil, fmt.Errorf("本地文件不可用（非桌面会话）")
	}
	path, _ := args["path"].(string)
	content, _ := args["content"].(string)
	if path == "" {
		return nil, fmt.Errorf("missing path")
	}
	res, err := br.RequestFile(ctx, "write", path, content)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "result": res}, nil
}
