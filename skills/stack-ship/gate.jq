# stack-ship step-2 gate. Run as: roborev list --json ... | GATE_RANGE=... jq -e -f gate.jq
# Lives in a file, not inline in SKILL.md: a command-rewriting hook ate one
# level of backslash from the inline program and the gate stopped compiling.
#
# Fail-closed: exits non-zero on any F verdict among completed jobs, any
# crashed (failed) review job, a non-array response, a null/empty response,
# a branch with zero completed P verdicts, or a done-job verdict outside P/F
# (schema drift must break the gate, not pass it). `null` (API error) and
# `[]` (nothing to show evidence for) must NOT normalize into a vacuous
# pass: the --branch review that runs first always enqueues at least one job
# for the branch's commits, so a real response has >=1 done job by the time
# we get here; anything else means the query itself is broken, not that the
# branch is clean. A failed job means a commit went unreviewed; re-run it
# (roborev review <sha>). roborev cannot close or cancel a failed job, so it
# is superseded instead by a LATER (higher id) done review of the same
# git_ref, or of EXACTLY the branch as it stands: GATE_RANGE, the
# "<merge-base>..<HEAD>" git_ref roborev records for --branch, the one range
# that covers every commit on the branch. Any other range (a --since review,
# a --branch review of an older HEAD) supersedes nothing. A failed job with
# no later done review still blocks, and so does a crashed --branch review
# itself; a branch of all-crashed reviews must not submit as if it were
# green. Supersession needs a numeric id and a string git_ref on BOTH jobs
# (jq orders numbers above null and null == null), and a GATE_RANGE of two
# hex SHAs: unset, empty, or malformed, range supersession is off.
# Queued/running/canceled jobs carry verdict:null and are excluded:
# preflight already drained the queue, and the gate's --branch review
# enqueues jobs the moment it runs.
type=="array"
and all(.[]; .status=="queued" or .status=="running" or .status=="done"
             or .status=="failed" or .status=="canceled")
and all(.[] | select(.status=="done"); .verdict=="P" or .verdict=="F")
and all(.[] | select(.status!="done"); .verdict==null)
and ([.[] | select(.status=="done" and .verdict=="F")] | length == 0)
and ([.[] | select(.status=="done")] as $done
     | [.[] | select(.status=="failed") | . as $f
        | select([$done[] | select((.id|type)=="number" and ($f.id|type)=="number"
                   and (.git_ref|type)=="string" and ($f.git_ref|type)=="string"
                   and .id > $f.id
                   and (.git_ref == $f.git_ref
                        or ((env.GATE_RANGE // "" | test("^[0-9a-f]{7,64}\\.\\.[0-9a-f]{7,64}$"))
                            and .git_ref == env.GATE_RANGE)))] | length == 0)]
     | length == 0)
and ([.[] | select(.status=="done" and .verdict=="P")] | length >= 1)
