package connector

import (
	"fmt"
	"math"
	"reflect"
	"unicode/utf8"
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
			value, ok := v.(string)
			if !ok {
				return fmt.Errorf("%s must be string", p.Name)
			}
			length := utf8.RuneCountInString(value)
			if p.MinLength != nil && length < *p.MinLength {
				return fmt.Errorf("%s length must be at least %d", p.Name, *p.MinLength)
			}
			if p.MaxLength != nil && length > *p.MaxLength {
				return fmt.Errorf("%s length must be at most %d", p.Name, *p.MaxLength)
			}
		case ParamInteger:
			n, ok := v.(float64)
			if !ok || n != math.Trunc(n) {
				return fmt.Errorf("%s must be integer", p.Name)
			}
			if p.Minimum != nil && n < float64(*p.Minimum) {
				return fmt.Errorf("%s must be at least %d", p.Name, *p.Minimum)
			}
			if p.Maximum != nil && n > float64(*p.Maximum) {
				return fmt.Errorf("%s must be at most %d", p.Name, *p.Maximum)
			}
		case ParamBoolean:
			if _, ok := v.(bool); !ok {
				return fmt.Errorf("%s must be boolean", p.Name)
			}
		default:
			return fmt.Errorf("unsupported parameter type %q", typ)
		}
		if len(p.Enum) > 0 && !enumContains(p.Enum, v) {
			return fmt.Errorf("%s must be one of %v", p.Name, p.Enum)
		}
	}
	return nil
}

func enumContains(values []any, got any) bool {
	for _, value := range values {
		if reflect.DeepEqual(value, got) {
			return true
		}
		left, leftOK := integerEnumValue(value)
		right, rightOK := integerEnumValue(got)
		if leftOK && rightOK && left == right {
			return true
		}
	}
	return false
}

func integerEnumValue(value any) (int64, bool) {
	switch n := value.(type) {
	case int:
		return int64(n), true
	case int8:
		return int64(n), true
	case int16:
		return int64(n), true
	case int32:
		return int64(n), true
	case int64:
		return n, true
	case uint:
		if uint64(n) <= math.MaxInt64 {
			return int64(n), true
		}
	case uint8:
		return int64(n), true
	case uint16:
		return int64(n), true
	case uint32:
		return int64(n), true
	case uint64:
		if n <= math.MaxInt64 {
			return int64(n), true
		}
	case float64:
		if n == math.Trunc(n) && n >= math.MinInt64 && n <= math.MaxInt64 {
			return int64(n), true
		}
	}
	return 0, false
}
