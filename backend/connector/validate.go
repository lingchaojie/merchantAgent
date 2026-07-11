package connector

import (
	"fmt"
	"math"
)

// ValidateArgs checks model-provided arguments against a tool's declared schema.
func ValidateArgs(spec ToolSpec, args map[string]any) error {
	params := map[string]ParamSpec{}
	for _, p := range spec.Params {
		params[p.Name] = p
	}
	for name := range args {
		if _, ok := params[name]; !ok {
			return fmt.Errorf("unknown argument %s", name)
		}
	}
	for _, p := range spec.Params {
		typ := p.Type
		if typ == "" {
			typ = ParamString
		}
		v, ok := args[p.Name]
		if !ok || v == nil || (typ == ParamString && v == "") {
			if p.Required {
				return fmt.Errorf("missing required argument %s", p.Name)
			}
			continue
		}
		switch typ {
		case ParamString:
			if _, ok := v.(string); !ok {
				return fmt.Errorf("%s must be string", p.Name)
			}
		case ParamInteger:
			n, ok := v.(float64)
			if !ok || n != math.Trunc(n) {
				return fmt.Errorf("%s must be integer", p.Name)
			}
		case ParamBoolean:
			if _, ok := v.(bool); !ok {
				return fmt.Errorf("%s must be boolean", p.Name)
			}
		default:
			return fmt.Errorf("unsupported parameter type %q", typ)
		}
	}
	return nil
}
