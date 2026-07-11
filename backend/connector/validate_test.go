package connector

import (
	"strings"
	"testing"
)

func TestValidateArgs(t *testing.T) {
	spec := ToolSpec{Params: []ParamSpec{
		{Name: "orderId", Type: ParamString, Required: true},
		{Name: "completionRate", Type: ParamInteger, Required: true},
	}}
	for _, tc := range []struct {
		name string
		args map[string]any
		want string
	}{
		{"valid", map[string]any{"orderId": "SO-1001", "completionRate": float64(80)}, ""},
		{"missing", map[string]any{"orderId": "SO-1001"}, "missing required argument completionRate"},
		{"wrong type", map[string]any{"orderId": "SO-1001", "completionRate": "80"}, "completionRate must be integer"},
		{"unknown", map[string]any{"orderId": "SO-1001", "completionRate": float64(80), "sql": "DROP"}, "unknown argument sql"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateArgs(spec, tc.args)
			if tc.want == "" && err != nil {
				t.Fatal(err)
			}
			if tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)) {
				t.Fatalf("err=%v want %q", err, tc.want)
			}
		})
	}
}

func TestValidateArgsEmptyTypeDefaultsToString(t *testing.T) {
	spec := ToolSpec{Params: []ParamSpec{{Name: "orderId", Required: true}}}
	err := ValidateArgs(spec, map[string]any{"orderId": ""})
	if err == nil || !strings.Contains(err.Error(), "missing required argument orderId") {
		t.Fatalf("err=%v, want missing required argument", err)
	}
}
