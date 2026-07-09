package sync

// Diff is the set of tuple writes and deletes needed to move OpenFGA from its
// current state to the desired state.
type Diff struct {
	Writes  []Tuple
	Deletes []Tuple
}

// Empty reports whether there is nothing to change.
func (d Diff) Empty() bool { return len(d.Writes) == 0 && len(d.Deletes) == 0 }

// Reconcile computes the idempotent diff: writes = desired−current,
// deletes = current−desired. Running it repeatedly with the same inputs yields
// an empty diff, which is what makes the sync safe to replay on duplicate or
// out-of-order org-change callbacks. Deletes matter most for security: a quit
// employee's tuples must disappear.
func Reconcile(current, desired []Tuple) Diff {
	cur := index(current)
	des := index(desired)

	var d Diff
	for k, t := range des {
		if _, ok := cur[k]; !ok {
			d.Writes = append(d.Writes, t)
		}
	}
	for k, t := range cur {
		if _, ok := des[k]; !ok {
			d.Deletes = append(d.Deletes, t)
		}
	}
	return d
}

func index(ts []Tuple) map[string]Tuple {
	m := make(map[string]Tuple, len(ts))
	for _, t := range ts {
		m[t.String()] = t
	}
	return m
}
