package tools

import (
	"fmt"
	"strings"
	"testing"
)

func TestSplitLines(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"a", []string{"a"}},
		{"a\n", []string{"a"}},
		{"a\nb", []string{"a", "b"}},
		{"a\nb\n", []string{"a", "b"}},
		{"\n", []string{""}},
	}
	for _, c := range cases {
		got := splitLines(c.in)
		if len(got) != len(c.want) {
			t.Errorf("splitLines(%q) = %q, want %q", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("splitLines(%q)[%d] = %q, want %q", c.in, i, got[i], c.want[i])
			}
		}
	}
}

func TestUnifiedDiff(t *testing.T) {
	cases := []struct {
		name string
		a, b string
		ctx  int
		want string
	}{
		{
			name: "identical",
			a:    "same\n", b: "same\n", ctx: 3,
			want: "",
		},
		{
			name: "no context",
			a:    "one\ntwo\nthree\n", b: "one\ntwo\nTHREE\n", ctx: 0,
			want: "@@ -3,1 +3,1 @@\n-three\n+THREE\n",
		},
		{
			name: "context lines",
			a:    "one\ntwo\nthree\nfour\nfive\n", b: "one\ntwo\nTHREE\nfour\nfive\n", ctx: 3,
			want: "@@ -1,5 +1,5 @@\n one\n two\n-three\n+THREE\n four\n five\n",
		},
		{
			name: "deletion",
			a:    "a\nb\nc\n", b: "a\nc\n", ctx: 1,
			want: "@@ -1,3 +1,2 @@\n a\n-b\n c\n",
		},
		{
			name: "new file",
			a:    "", b: "a\nb\n", ctx: 3,
			want: "@@ -0,0 +1,2 @@\n+a\n+b\n",
		},
		{
			name: "empty file",
			a:    "x\n", b: "", ctx: 3,
			want: "@@ -1,1 +0,0 @@\n-x\n",
		},
		{
			name: "changes near merge into one hunk",
			a:    "p\nA\nq\nq\nB\nr\n", b: "p\nA2\nq\nq\nB2\nr\n", ctx: 1,
			want: "@@ -1,6 +1,6 @@\n p\n-A\n+A2\n q\n q\n-B\n+B2\n r\n",
		},
		{
			name: "far changes split into hunks",
			a:    "1\n2\nA\n3\n4\n5\n6\nB\n7\n8\n", b: "1\n2\na\n3\n4\n5\n6\nb\n7\n8\n", ctx: 0,
			want: "@@ -3,1 +3,1 @@\n-A\n+a\n@@ -8,1 +8,1 @@\n-B\n+b\n",
		},
		{
			name: "insertion at end",
			a:    "a\n", b: "a\nb\nc\n", ctx: 0,
			want: "@@ -1,0 +2,2 @@\n+b\n+c\n",
		},
	}
	for _, c := range cases {
		if got := UnifiedDiff(c.a, c.b, c.ctx); got != c.want {
			t.Errorf("%s: UnifiedDiff =\n%q\nwant\n%q", c.name, got, c.want)
		}
	}
}

func TestDiffStat(t *testing.T) {
	removed, added := DiffStat("1\n2\n3\n", "1\nfour\n3\n5\n")
	if removed != 1 || added != 2 {
		t.Errorf("DiffStat = (%d, %d), want (1, 2)", removed, added)
	}
	removed, added = DiffStat("x\n", "x\n")
	if removed != 0 || added != 0 {
		t.Errorf("identical DiffStat = (%d, %d), want (0, 0)", removed, added)
	}
}

// Guard against accidental quadratic blowup: the common prefix/suffix
// trim keeps the table at the changed middle only.
func TestDiffLargeFileTrims(t *testing.T) {
	var a, b strings.Builder
	for i := 0; i < 50_000; i++ {
		fmt.Fprintf(&a, "line %d\n", i)
		fmt.Fprintf(&b, "line %d\n", i)
	}
	b.WriteString("extra\n")
	removed, added := DiffStat(a.String(), b.String())
	if removed != 0 || added != 1 {
		t.Errorf("DiffStat on 50k-line file = (%d, %d), want (0, 1)", removed, added)
	}
}
