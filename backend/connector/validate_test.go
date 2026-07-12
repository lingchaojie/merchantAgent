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

func TestToolSpecWithDefaults(t *testing.T) {
	for _, tc := range []struct {
		name string
		spec ToolSpec
		want ToolSpec
	}{
		{
			name: "empty values use legacy defaults",
			want: ToolSpec{Execution: ExecutionServer, Risk: RiskRead},
		},
		{
			name: "explicit values are preserved",
			spec: ToolSpec{Execution: ExecutionDesktop, Risk: RiskHighWrite},
			want: ToolSpec{Execution: ExecutionDesktop, Risk: RiskHighWrite},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.spec.WithDefaults()
			if got.Execution != tc.want.Execution || got.Risk != tc.want.Risk {
				t.Fatalf("WithDefaults() execution/risk = %q/%q, want %q/%q",
					got.Execution, got.Risk, tc.want.Execution, tc.want.Risk)
			}
		})
	}
}

func TestValidateArgsEnforcesPublishedConstraints(t *testing.T) {
	minLength, maxLength, minimum, maximum := 2, 4, 1, 3
	spec := ToolSpec{Params: []ParamSpec{
		{Name: "code", Type: ParamString, MinLength: &minLength, MaxLength: &maxLength, Enum: []any{"AB", "ABC"}},
		{Name: "count", Type: ParamInteger, Minimum: &minimum, Maximum: &maximum, Enum: []any{float64(1), float64(3)}},
	}}
	for _, tc := range []struct {
		name string
		args map[string]any
		want string
	}{
		{name: "valid", args: map[string]any{"code": "AB", "count": float64(3)}},
		{name: "string too short", args: map[string]any{"code": "A"}, want: "code length must be at least 2"},
		{name: "string too long", args: map[string]any{"code": "ABCDE"}, want: "code length must be at most 4"},
		{name: "string outside enum", args: map[string]any{"code": "AC"}, want: "code must be one of"},
		{name: "integer below minimum", args: map[string]any{"count": float64(0)}, want: "count must be at least 1"},
		{name: "integer above maximum", args: map[string]any{"count": float64(4)}, want: "count must be at most 3"},
		{name: "integer outside enum", args: map[string]any{"count": float64(2)}, want: "count must be one of"},
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

func TestValidateArgsAcceptsIntegerEnumDeclaredWithGoInts(t *testing.T) {
	spec := ToolSpec{Params: []ParamSpec{{
		Name: "count", Type: ParamInteger, Enum: []any{1, 3},
	}}}
	if err := ValidateArgs(spec, map[string]any{"count": float64(3)}); err != nil {
		t.Fatal(err)
	}
}
