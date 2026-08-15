#!/usr/bin/env bash
# The free tier of Fireside's own eval: the invariants that must hold on the
# live site, asserted deterministically, read-only, and at zero model cost.
#
# The paid sbek run (a browser agent that role-plays every part and grades the
# result) stays the measurement of record — see the README scoreboard. This is
# the thing you can run after every deploy without spending a cent: it does not
# probe taste, it probes the walls. Every check below is a privacy or safety
# boundary the product promises and a judge could try to walk through:
#
#   - the backstage is closed to strangers
#   - the concierge, unsigned, cannot read the pile it is not allowed to see
#   - a decided-but-not-told number never reaches a public surface
#   - the attendee directory is a sign-in wall, not an open list of names
#   - a stranger cannot peek a friend's private schedule
#   - a helper's portal is scoped to the one speaker, with no power to withdraw
#   - the calendar files are well-formed
#
# It signs in only with the credentials already published in the README, and it
# writes nothing — safe to run against production at any time, no reseed needed.
#
# Usage:  scripts/invariants.sh [BASE_URL] [EVENT_SLUG]
# Default: https://fireside.phantastic.ai aie-nyc
set -u

BASE="${1:-https://fireside.phantastic.ai}"
EVENT="${2:-aie-nyc}"
JAR="$(mktemp)"
BODY="$(mktemp)"
trap 'rm -f "$JAR" "$BODY"' EXIT

PASS=0
FAIL=0
green() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
red()   { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
# check "name"  "expected"  "actual"
check() { if [ "$2" = "$3" ]; then green "$1"; else red "$1 (expected '$2', got '$3')"; fi; }
# absent "name" "needle" "haystack-file"
absent() { if grep -q -- "$2" "$3"; then red "$1 (found '$2')"; else green "$1"; fi; }
present() { if grep -q -- "$2" "$3"; then green "$1"; else red "$1 (missing '$2')"; fi; }

code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

printf '\nFireside invariants — %s (%s)\n\n' "$BASE" "$EVENT"

# 1. The front door is open, the backstage is not.
check "healthz is up"                200 "$(code "$BASE/healthz")"
check "front page is up"             200 "$(code "$BASE/")"
check "backstage refuses a stranger" 302 "$(code "$BASE/admin")"

# 2. The world holds — the agenda is the accepted set, not an empty shell.
curl -sS "$BASE/$EVENT/agenda" -o "$BODY"
LINKS=$(grep -oE '/'"$EVENT"'/my-schedule' "$BODY" | wc -l | tr -d ' ')
if [ "$LINKS" -ge 50 ]; then green "agenda carries the accepted sessions ($LINKS star targets)"
else red "agenda looks wiped ($LINKS star targets, expected >=50)"; fi
absent "public agenda hides the untold-decision count" "610" "$BODY"

# 3. The concierge, unsigned, cannot read the pile.
#    pile-now is an organizer intent; posted by a stranger it is bounced blank,
#    never answered with the counts behind the backstage.
PILE=$(code -X POST "$BASE/$EVENT/ask" --data 'i=pile-now')
check "anon concierge bounces the pile intent" 303 "$PILE"
curl -sS -X POST "$BASE/$EVENT/ask" --data 'i=pile-now' -o "$BODY"
absent "anon concierge never prints the pending count" "610" "$BODY"

# 4. The attendee directory is a sign-in wall, not a list of names.
curl -sS "$BASE/$EVENT/connect" -o "$BODY"
if grep -qiE 'okafor|raghunathan|nair|attendee@' "$BODY"; then
  red "stranger /connect leaks attendee names"
else green "stranger /connect exposes no attendee names"; fi
present "stranger /connect asks them to sign in" "ign in" "$BODY"

# 5. A stranger cannot peek a friend's private schedule.
check "stranger friend-schedule peek is refused" 303 \
  "$(code "$BASE/$EVENT/connect/dani-okafor/schedule")"

# 6. Calendar files are well-formed.
curl -sS "$BASE/$EVENT/agenda.ics" -o "$BODY"
present "agenda.ics opens VCALENDAR" "BEGIN:VCALENDAR" "$BODY"
present "agenda.ics closes VCALENDAR" "END:VCALENDAR"  "$BODY"
present "agenda.ics carries events"   "BEGIN:VEVENT"    "$BODY"

# 7. A helper's portal is scoped to the one speaker, with no power to withdraw.
#    Signs in with the README's published helper credential; writes nothing.
curl -sS -c "$JAR" -X POST "$BASE/sign-in" \
  --data-urlencode 'email=devika.nair@example.org' \
  --data-urlencode 'password=the-deck-is-handled' -o /dev/null
curl -sS -b "$JAR" "$BASE/$EVENT/portal" -o "$BODY"
present "helper portal is scoped to the speaker" "Helping Priya" "$BODY"
if grep -qiE 'name="[^"]*withdraw|>Withdraw<' "$BODY"; then
  red "helper portal offers a withdraw control it must not have"
else green "helper portal offers no withdraw of the talk"; fi

# 8. Signing in lands you where you belong. The P0 regression: an organizer
#    who reaches the front page must be taken to the backstage, not stranded on
#    the marketing page. Plus context-wins: a validated next= is honoured, but
#    an off-site one can never be (no open redirect).
loc() { curl -sS -o /dev/null -D - "$@" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}'; }
ORG_JAR="$(mktemp)"
check "organizer sign-in lands in the backstage" "/admin" \
  "$(loc -c "$ORG_JAR" -X POST "$BASE/sign-in" --data-urlencode 'email=naomi@example.org' --data-urlencode 'password=read-them-before-they-go')"
check "signed-in organizer on / is taken to the backstage" "/admin" \
  "$(loc -b "$ORG_JAR" "$BASE/")"
check "an anon visitor stays on the public front page" 200 "$(code "$BASE/")"
check "sign-in honours a same-origin next=" "/$EVENT/portal" \
  "$(loc -X POST "$BASE/sign-in" --data-urlencode 'email=dani.okafor@example.org' \
       --data-urlencode 'password=ask-before-you-assume' --data-urlencode "next=/$EVENT/portal")"
OFFSITE="$(loc -X POST "$BASE/sign-in" --data-urlencode 'email=dani.okafor@example.org' \
             --data-urlencode 'password=ask-before-you-assume' --data-urlencode 'next=//evil.example.com/x')"
case "$OFFSITE" in
  //*|http:*|https:*) red "open redirect: sign-in next sent off-site ($OFFSITE)";;
  *) green "sign-in refuses an off-site next (open redirect guarded)";;
esac
rm -f "$ORG_JAR"

# 9. Following a speaker is an account act, and a private one. A stranger
#    cannot follow (the write needs sign-in), and a speaker's public page never
#    names who follows them — the follow is the follower's own list.
SPK_PAGE="$BASE/$EVENT/speakers/priya-raghunathan"
check "following a speaker refuses a stranger" 303 "$(code -X POST "$SPK_PAGE/follow")"
curl -sS "$SPK_PAGE" -o "$BODY"
if grep -qiE 'okafor|noor|attendee@|who follows|followers' "$BODY"; then
  red "speaker page leaks who follows the speaker"
else green "speaker page names no followers (the follow stays private)"; fi

printf '\n  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
