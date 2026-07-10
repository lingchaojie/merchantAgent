package config

import (
	"testing"
)

func TestOpen_Seeded(t *testing.T) {
	s, err := Open("mock-corp-001")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var roles, rules, domains, grants int
	s.db.QueryRow(`SELECT COUNT(*) FROM roles`).Scan(&roles)
	s.db.QueryRow(`SELECT COUNT(*) FROM role_rules`).Scan(&rules)
	s.db.QueryRow(`SELECT COUNT(*) FROM data_domains`).Scan(&domains)
	s.db.QueryRow(`SELECT COUNT(*) FROM domain_grants`).Scan(&grants)
	if roles != 7 || rules != 6 || domains != 2 || grants != 3 {
		t.Fatalf("seed counts = roles %d rules %d domains %d grants %d; want 7/6/2/3", roles, rules, domains, grants)
	}
}
