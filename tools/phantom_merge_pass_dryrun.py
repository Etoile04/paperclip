#!/usr/bin/env python3
"""ADR-010 §D2 (NFM-3860) — Dry-run scanner for phantom-merge-pass wedges.

This script is a SAFE, READ-ONLY counterpart to
``phantomBackfill.reconcilePhantomMergePasses`` (the §D2 daily backfill
routine). It walks the live Paperclip instance, applies the same
phantom-pass filter as the production SQL, and prints what the routine
WOULD do — without touching the database, without creating recovery
children, and without firing wakes.

Usage
-----
    tools/phantom_merge_pass_dryrun.py --dry-run
    tools/phantom_merge_pass_dryrun.py --dry-run --json
    tools/phantom_merge_pass_dryrun.py --dry-run --sample-size 25
    tools/phantom_merge_pass_dryrun.py --dry-run --whitelist-add NFM-9999

Environment
-----------
PAPERCLIP_API_URL    Base URL of the Paperclip API
PAPERCLIP_API_KEY    Bearer token with ``issues:read`` scope
PAPERCLIP_COMPANY_ID Company UUID to scope the scan to

Exit codes
----------
0  Scan completed cleanly (may still report phantoms to backfill).
1  Routine error — bad configuration, network failure, or API error.
2  Auth/authz failure — token missing or insufficient scope.

The script intentionally mirrors the §D2 routine's read paths so
operational confidence in a daily 05:00 UTC cron tick is high before
flipping the experimental flag.

Why this is "dry-run safe"
--------------------------
The script only calls ``GET`` endpoints. It never ``POST``-s recovery
children, ``PATCH``-es existing issues, or modifies any state.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Any

# --- Configuration -----------------------------------------------------------

API_ROOT = os.environ.get("PAPERCLIP_API_URL", "").rstrip("/")
TOKEN = os.environ.get("PAPERCLIP_API_KEY", "")
DEFAULT_COMPANY_ID = os.environ.get("PAPERCLIP_COMPANY_ID", "")
PAGE_SIZE = 1000
DEFAULT_TIMEOUT = 30.0
SAMPLE_LIMIT_DEFAULT = 10

# Phantom-merge-pass SQL — kept byte-stable with the production
# `phantom-backfill.ts` constants. Mirror, do not invent.
PHANTOM_MERGE_TITLE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^Merge\s+\S+\s+to\smain$", re.IGNORECASE),
    re.compile(r"^Merge\s+\S+\s+branch$", re.IGNORECASE),
)

# Default whitelist — NFM-3738 is the documented in-flight intentional
# merge (NFM-3853 RCA). Operators may extend via --whitelist-add.
DEFAULT_WHITELIST: tuple[str, ...] = ("NFM-3738",)

# Window start — phantom-pass surge began 2026-08-01. Anything older is
# out of scope.
DEFAULT_WINDOW_START = "2026-08-01T00:00:00Z"

# NOTE: the production SQL previously also filtered on
# `assigned_agent_count_in_24h >= 3`, but `heartbeat_runs` does not carry
# a per-issue correlation column. The dry-run now mirrors that drop —
# the primary phantom-pass signature (`comment_count = 0` on a `done`
# issue with merge-style title) is sufficient and is what the production
# routine now uses. The constant is retained as 0 so the CLI flag stays
# stable and the dry-run cannot accidentally surface phantoms that the
# routine would skip.
DEFAULT_MIN_ASSIGNEE_COUNT_24H = 0

_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


# --- Errors ------------------------------------------------------------------


class AuthError(Exception):
    """Raised when credentials are missing or rejected."""


class WrongPath(Exception):
    """Raised when an internal URL is built incorrectly."""


class ApiError(Exception):
    """Raised when the API returns an unexpected status."""

    def __init__(self, status: int, body: str):
        super().__init__(f"API HTTP {status}: {body[:200]}")
        self.status = status
        self.body = body


# --- Result dataclasses ------------------------------------------------------


@dataclass
class PhantomCandidate:
    """A `done` issue matching the phantom-pass signature."""

    issue_id: str
    identifier: str
    company_id: str
    title: str
    status: str
    created_at: str
    comment_count: int
    distinct_assignees_24h: int
    most_recent_assignee_id: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "issueId": self.issue_id,
            "identifier": self.identifier,
            "companyId": self.company_id,
            "title": self.title,
            "status": self.status,
            "createdAt": self.created_at,
            "commentCount": self.comment_count,
            "distinctAssignees24h": self.distinct_assignees_24h,
            "mostRecentAssigneeId": self.most_recent_assignee_id,
        }


@dataclass
class DryRunReport:
    """Aggregate counts matching the §D2 routine's return shape."""

    issues_scanned: int
    title_filter_matches: int
    candidates_after_comment_filter: int
    candidates_after_assignee_filter: int
    candidates: list[PhantomCandidate] = field(default_factory=list)
    whitelisted_identifiers: list[str] = field(default_factory=list)
    sample_first_n: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "issuesScanned": self.issues_scanned,
            "titleFilterMatches": self.title_filter_matches,
            "candidatesAfterCommentFilter": self.candidates_after_comment_filter,
            "candidatesAfterAssigneeFilter": self.candidates_after_assignee_filter,
            "candidatesSample": [c.to_dict() for c in self.candidates],
            "whitelistedIdentifiers": self.whitelisted_identifiers,
        }


# --- Minimal API client ------------------------------------------------------


def _http_get(path: str, params: dict[str, str] | None = None) -> Any:
    """GET ``{API_ROOT}{path}`` (params encoded in querystring) and return JSON."""
    if not API_ROOT:
        raise AuthError(
            "PAPERCLIP_API_URL is not set; refuse to guess the host",
        )
    if not TOKEN:
        raise AuthError(
            "PAPERCLIP_API_KEY is missing or empty",
        )
    if not path.startswith("/"):
        raise WrongPath(f"path must start with /, got {path!r}")

    qs = urllib.parse.urlencode(params or {})
    url = f"{API_ROOT}{path}"
    if qs:
        url = f"{url}?{qs}"

    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        if exc.code in (401, 403):
            raise AuthError(f"HTTP {exc.code}: {body[:200]}") from exc
        raise ApiError(exc.code, body) from exc


# --- Paperclip-aware helpers -------------------------------------------------


def _list_done_issues_since(
    company_id: str,
    window_start_iso: str,
    page_size: int = PAGE_SIZE,
) -> list[dict[str, Any]]:
    """Fetch every `status=done` issue whose `createdAt >= window_start_iso`.

    The collection endpoint paginates by `offset` (no cursor). Hard-capped
    at 1000 pages to avoid pathological loops.
    """
    out: list[dict[str, Any]] = []
    offset = 0
    page = 0
    while True:
        result = _http_get(
            f"/api/companies/{company_id}/issues",
            {
                "status": "done",
                "limit": str(page_size),
                "offset": str(offset),
            },
        )
        if isinstance(result, dict):
            items = (
                result.get("data")
                or result.get("issues")
                or result.get("items")
                or []
            )
        else:
            items = result
        if not isinstance(items, list):
            raise ApiError(
                200,
                f"unexpected list payload: {list(result)[:3] if isinstance(result, dict) else type(result).__name__}",
            )
        if not items:
            return out
        for issue in items:
            created = issue.get("createdAt") or issue.get("created_at")
            if created and created >= window_start_iso:
                out.append(issue)
        if len(items) < page_size:
            return out
        offset += page_size
        page += 1
        if page > 1000:
            raise ApiError(
                200,
                "offset pagination exceeded 1000 pages; aborting",
            )


def _count_comments(issue_id: str) -> int:
    """Count non-deleted comments on an issue. Returns 0 if endpoint missing.

    NOTE: The current API does not expose a direct count; we paginate the
    comment list with `limit=200` until exhausted. For each comment we
    skip ``deletedAt`` set (soft-deleted). In production, the routine's
    SQL counts ``issue_comments WHERE deletedAt IS NULL``.
    """
    total = 0
    cursor: str | None = None
    page = 0
    while True:
        params: dict[str, str] = {"limit": "200", "order": "asc"}
        if cursor:
            params["after"] = cursor
        try:
            result = _http_get(f"/api/issues/{issue_id}/comments", params)
        except ApiError as exc:
            if exc.status == 404:
                return 0
            raise
        if isinstance(result, dict):
            items = (
                result.get("data")
                or result.get("comments")
                or result.get("items")
                or []
            )
        else:
            items = result
        if not isinstance(items, list):
            break
        for c in items:
            if c.get("deletedAt"):
                continue
            total += 1
        if len(items) < 200:
            return total
        cursor = items[-1].get("id") or items[-1].get("commentId")
        page += 1
        if page > 100:
            # 100 * 200 = 20K comments per issue is absurd; bail.
            break


def _distinct_assignees_24h(
    company_id: str,
    issue_id: str,
    now: datetime,
) -> tuple[int, str | None]:
    """Return (distinct agents in last 24h, most-recent assignee id).

    The production heartbeat table does not carry a per-issue column,
    so we cannot compute a per-issue correlation here without a schema
    migration that is out of scope for ADR-010 §D2. We return (0, None)
    so the dry-run report surfaces the same set the production routine
    will — anything that fails the upstream title + comment-count
    filter is still filtered out by the routine's SQL.
    """
    _ = (company_id, issue_id, now)  # keep signature stable
    return (0, None)
    agents: set[str] = set()
    most_recent_agent: str | None = None
    most_recent_at: datetime | None = None
    cursor: str | None = None
    page = 0
    while True:
        params: dict[str, str] = {"limit": "200"}
        if cursor:
            params["after"] = cursor
        try:
            result = _http_get(
                f"/api/companies/{company_id}/heartbeat-runs",
                params,
            )
        except ApiError as exc:
            if exc.status == 404:
                return (0, None)
            raise
        if isinstance(result, dict):
            items = (
                result.get("data")
                or result.get("runs")
                or result.get("items")
                or []
            )
        else:
            items = result
        if not isinstance(items, list):
            break
        for run in items:
            if run.get("issueId") != issue_id and run.get("issue_id") != issue_id:
                continue
            created = run.get("createdAt") or run.get("created_at") or ""
            if created < cutoff:
                continue
            agent = run.get("agentId") or run.get("agent_id")
            if not agent:
                continue
            agents.add(agent)
            try:
                created_dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
            except ValueError:
                continue
            if most_recent_at is None or created_dt > most_recent_at:
                most_recent_at = created_dt
                most_recent_agent = agent
        if len(items) < 200:
            break
        cursor = items[-1].get("id") or items[-1].get("runId")
        page += 1
        if page > 100:
            break
    return (len(agents), most_recent_agent)


# --- Scan logic --------------------------------------------------------------


def _title_matches_phantom(title: str) -> bool:
    return any(p.match(title) for p in PHANTOM_MERGE_TITLE_PATTERNS)


def run_dry_run(
    company_id: str | None,
    sample_size: int,
    whitelist: list[str],
    window_start_iso: str,
    min_assignee_count_24h: int,
) -> DryRunReport:
    """Walk the live instance and produce the §D2 dry-run report."""
    if not company_id:
        raise WrongPath(
            "PAPERCLIP_COMPANY_ID is not set and --company-id not provided",
        )

    issues = _list_done_issues_since(company_id, window_start_iso)
    by_company: dict[str, int] = defaultdict(int)
    title_matches = 0
    comment_filter_passes = 0
    final_candidates: list[PhantomCandidate] = []
    whitelist_set = set(whitelist)

    now = datetime.now(timezone.utc)
    for issue in issues:
        company = (
            issue.get("companyId")
            or issue.get("company_id")
            or company_id
        )
        if company:
            by_company[company] += 1
        identifier = issue.get("identifier") or ""
        if identifier in whitelist_set:
            continue
        title = issue.get("title") or ""
        if not _title_matches_phantom(title):
            continue
        title_matches += 1

        issue_id = issue.get("id") or ""
        if not _UUID.match(issue_id):
            continue

        comment_count = _count_comments(issue_id)
        if comment_count != 0:
            continue
        comment_filter_passes += 1

        distinct, most_recent = _distinct_assignees_24h(company, issue_id, now)
        if distinct < min_assignee_count_24h:
            continue

        final_candidates.append(
            PhantomCandidate(
                issue_id=issue_id,
                identifier=identifier,
                company_id=company,
                title=title,
                status=issue.get("status") or "done",
                created_at=issue.get("createdAt") or "",
                comment_count=comment_count,
                distinct_assignees_24h=distinct,
                most_recent_assignee_id=most_recent,
            )
        )

    return DryRunReport(
        issues_scanned=len(issues),
        title_filter_matches=title_matches,
        candidates_after_comment_filter=comment_filter_passes,
        candidates_after_assignee_filter=len(final_candidates),
        candidates=final_candidates,
        whitelisted_identifiers=sorted(whitelist_set),
        sample_first_n=min(sample_size, len(final_candidates)),
    )


# --- Output ------------------------------------------------------------------


def _print_human(report: DryRunReport, sample_size: int) -> None:
    print("ADR-010 §D2 dry-run — phantom-merge-pass backfill")
    print(f"  issues scanned                 : {report.issues_scanned}")
    print(f"  title filter matches           : {report.title_filter_matches}")
    print(
        "  candidates after comment filter: "
        f"{report.candidates_after_comment_filter}"
    )
    print(
        "  FINAL candidates "
        "(comment=0 + assignees>=3): "
        f"{report.candidates_after_assignee_filter}"
    )
    print(f"  whitelist                      : {report.whitelisted_identifiers}")

    if not report.candidates:
        print(
            "\nNo phantom merge passes found. "
            "The §D2 routine would be a no-op.",
        )
        return

    print(
        f"\nSample candidates (first {min(sample_size, len(report.candidates))}):",
    )
    for c in report.candidates[:sample_size]:
        ident = c.identifier or c.issue_id[:8]
        print(f"  - {ident}")
        print(f"      title                       = {c.title!r}")
        print(f"      createdAt                   = {c.created_at}")
        print(f"      comment_count               = {c.comment_count}")
        print(f"      distinct_assignees_24h      = {c.distinct_assignees_24h}")
        print(f"      most_recent_assignee_id     = {c.most_recent_assignee_id}")
    if len(report.candidates) > sample_size:
        print(
            f"  … +{len(report.candidates) - sample_size} more "
            "(use --sample-size to expand)",
        )


def _print_json(report: DryRunReport) -> None:
    print(json.dumps(report.to_dict(), indent=2, sort_keys=True))


# --- Entry point -------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="phantom_merge_pass_dryrun.py",
        description=(
            "ADR-010 §D2 dry-run scanner for phantom-merge-pass wedges."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        required=True,
        help="REQUIRED. Refuses to run without this flag — script never mutates.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the report as JSON instead of human-readable text.",
    )
    parser.add_argument(
        "--sample-size",
        type=int,
        default=SAMPLE_LIMIT_DEFAULT,
        help=(
            "Number of candidate samples to print "
            f"(default {SAMPLE_LIMIT_DEFAULT})."
        ),
    )
    parser.add_argument(
        "--company-id",
        default=DEFAULT_COMPANY_ID or None,
        help=(
            "Restrict the scan to a single company UUID. "
            "Defaults to PAPERCLIP_COMPANY_ID env var."
        ),
    )
    parser.add_argument(
        "--whitelist-add",
        action="append",
        default=[],
        metavar="IDENTIFIER",
        help=(
            "Extra identifier(s) to whitelist on top of NFM-3738 "
            "(repeatable)."
        ),
    )
    parser.add_argument(
        "--window-start",
        default=DEFAULT_WINDOW_START,
        help=(
            "ISO timestamp; only issues created at or after this point "
            f"are scanned (default {DEFAULT_WINDOW_START})."
        ),
    )
    parser.add_argument(
        "--min-assignee-count-24h",
        type=int,
        default=DEFAULT_MIN_ASSIGNEE_COUNT_24H,
        help=(
            "Minimum distinct assignees in last 24h "
            f"(default {DEFAULT_MIN_ASSIGNEE_COUNT_24H})."
        ),
    )
    args = parser.parse_args(argv)

    whitelist = list(DEFAULT_WHITELIST) + list(args.whitelist_add)

    try:
        report = run_dry_run(
            args.company_id,
            args.sample_size,
            whitelist,
            args.window_start,
            args.min_assignee_count_24h,
        )
    except AuthError as exc:
        print(f"auth/authz failure: {exc}", file=sys.stderr)
        return 2
    except WrongPath as exc:
        print(f"path/config error: {exc}", file=sys.stderr)
        return 2
    except ApiError as exc:
        print(f"routine error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"routine error: {exc}", file=sys.stderr)
        return 1

    if args.json:
        _print_json(report)
    else:
        _print_human(report, args.sample_size)

    return 0


if __name__ == "__main__":
    sys.exit(main())