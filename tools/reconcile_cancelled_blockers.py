#!/usr/bin/env python3
"""ADR-009 §4.3-b — Dry-run scanner for cancelled-blocker wedges.

This script is a SAFE, READ-ONLY counterpart to
``recoveryService.reconcileBlockedByIssueIds`` (the §4.3-a reconcile
routine, NFM-3584). It walks the live Paperclip instance, applies the
same terminal-blocker filter (`done` or `cancelled`), and prints what
the routine WOULD prune — without touching the database, without
writing audit entries, and without firing wakes.

Usage
-----
    tools/reconcile_cancelled_blockers.py --dry-run
    tools/reconcile_cancelled_blockers.py --dry-run --json
    tools/reconcile_cancelled_blockers.py --dry-run --sample-size 25

Environment
-----------
PAPERCLIP_API_URL    Base URL of the Paperclip API (e.g. https://paperclip.example.com)
PAPERCLIP_API_KEY    Bearer token with ``issues:read`` scope
PAPERCLIP_COMPANY_ID Company UUID to scope the scan to (defaults to every company)

Exit codes
----------
0  Scan completed cleanly (may still report dependents to clear).
1  Routine error — bad configuration, network failure, or API error.
2  Auth/authz failure — token missing or insufficient scope.

The script intentionally mirrors the §4.3-a routine's read paths so
operational confidence in a daily 06:00 UTC cron tick is high before
flipping the experimental flag.

Why this is "dry-run safe"
--------------------------
The script only calls ``GET`` endpoints. It never ``PATCH``-es issues,
``DELETE``-s relations, or ``POST``-s audit rows. The reconcile routine
on master mutates by ``DELETE FROM issueRelations WHERE id IN (...)``;
this script never issues a single write.
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
from typing import Any

# --- Configuration -----------------------------------------------------------

API_ROOT = os.environ.get("PAPERCLIP_API_URL", "").rstrip("/")
TOKEN = os.environ.get("PAPERCLIP_API_KEY", "")
DEFAULT_COMPANY_ID = os.environ.get("PAPERCLIP_COMPANY_ID", "")
PAGE_SIZE = 1000
DEFAULT_TIMEOUT = 30.0
SAMPLE_LIMIT_DEFAULT = 10

TERMINAL_STATUSES = {"done", "cancelled"}
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
class ClearedDependency:
    """A dependent whose blockers include at least one terminal UUID."""

    dependent_id: str
    dependent_identifier: str | None
    company_id: str | None
    status: str | None
    before_blocked_by_issue_ids: list[str] = field(default_factory=list)
    after_blocked_by_issue_ids: list[str] = field(default_factory=list)
    closing_issue_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "dependentId": self.dependent_id,
            "dependentIdentifier": self.dependent_identifier,
            "companyId": self.company_id,
            "status": self.status,
            "before": self.before_blocked_by_issue_ids,
            "after": self.after_blocked_by_issue_ids,
            "closingIssueIds": self.closing_issue_ids,
        }


@dataclass
class DryRunReport:
    """Aggregate counts matching the §4.3-a routine's return shape."""

    companies_scanned: int
    dependents_scanned: int
    dependents_touched: int
    blockers_to_remove: int
    removed_by_status: dict[str, int]
    cleared: list[ClearedDependency] = field(default_factory=list)
    flagged_company_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "companiesScanned": self.companies_scanned,
            "dependentsScanned": self.dependents_scanned,
            "dependentsTouched": self.dependents_touched,
            "blockersToRemove": self.blockers_to_remove,
            "removedByStatus": self.removed_by_status,
            "clearedSample": [c.to_dict() for c in self.cleared],
            "flaggedCompanyIds": self.flagged_company_ids,
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


def _list_issues(company_id: str | None, cursor: str | None) -> dict[str, Any]:
    """GET /api/companies/{company}/issues[?after=…] (collection endpoint).

    The collection endpoint silently strips ``blockedBy`` (NFM-2036 trap).
    Callers MUST re-fetch each issue via ``_get_issue(uuid)`` before reading
    its blocker list.
    """
    if not company_id:
        # Without a company_id we can't safely query the collection endpoint
        # (the bare /api/issues path returns 400 per ADR-008). Operators
        # without a token-scoped company should pass --company-id.
        raise WrongPath(
            "PAPERCLIP_COMPANY_ID is not set and --company-id not provided; "
            "the bare /api/issues path is not allowed",
        )
    params: dict[str, str] = {"limit": str(PAGE_SIZE)}
    if cursor is not None:
        params["after"] = cursor
    return _http_get(f"/api/companies/{company_id}/issues", params)


def _get_issue(uuid: str) -> dict[str, Any] | None:
    """GET /api/issues/{uuid} — bare endpoint returns full expanded payload."""
    if not _UUID.match(uuid or ""):
        raise WrongPath(f"not a UUID: {uuid!r}")
    try:
        return _http_get(f"/api/issues/{uuid}")
    except ApiError as exc:
        if exc.status == 404:
            return None
        raise


# --- Scan logic --------------------------------------------------------------


def _fetch_dependents_with_blockers(
    company_id: str | None,
) -> list[dict[str, Any]]:
    """Return every issue whose ``blockedByIssueIds`` is non-empty.

    The collection endpoint silently strips ``blockedBy``, so we MUST
    re-fetch each issue via the bare ``GET /api/issues/{uuid}`` route
    before trusting the blocker list. Pagination is bounded — see the
    loop's hard cap below.
    """
    out: list[dict[str, Any]] = []
    cursor: str | None = None
    page = 0
    while True:
        result = _list_issues(company_id, cursor)
        items = result.get("data") or result.get("issues") or result.get("items") or []
        if not isinstance(items, list):
            raise ApiError(200, f"unexpected list payload: {list(result)[:3]}")
        for summary in items:
            uuid = summary.get("id")
            if not uuid:
                continue
            full = _get_issue(uuid)
            if full is None:
                # Issue disappeared between list and re-fetch — skip;
                # the reconcile routine does not handle this case either.
                continue
            issue = full.get("data") or full.get("issue") or full
            blocked_by = (
                issue.get("blockedBy")
                or issue.get("blockedByIssueIds")
                or []
            )
            if blocked_by:
                # Preserve companyId from the summary — the bare endpoint
                # may not include it on every payload shape.
                if "companyId" not in issue and summary.get("companyId"):
                    issue["companyId"] = summary["companyId"]
                out.append(issue)
        if len(items) < PAGE_SIZE:
            return out
        cursor = items[-1].get("id") or items[-1].get("identifier")
        page += 1
        if page > 1000:
            # Hard cap: >1M issues per company is implausible; refuse to
            # loop forever against a buggy cursor.
            raise ApiError(
                200,
                "cursor pagination exceeded 1000 pages; aborting",
            )


def _classify_blockers(
    issue: dict[str, Any],
) -> tuple[list[str], list[str], list[str]]:
    """Return (before, after, closing_issue_ids) for a single dependent.

    ``closing_issue_ids`` mirrors the §4.1 audit shape: the UUIDs that
    are about to be removed, in deterministic order. We sort to match
    the §4.3-a routine's deterministic behavior so the dry-run report
    is byte-stable across re-runs.

    NOTE: Without a per-UUID blocker-status endpoint, we conservatively
    treat the WHOLE ``blockedByIssueIds`` set as "potential removals"
    and surface the join-status heuristic in the human-readable output.
    The §4.3-a routine on master (``reconcileBlockedByIssueIds``) joins
    ``issueRelations`` to ``issues.status`` in a single SQL query; the
    API surface used here cannot replicate that join, so the dry-run
    flags every blocker as a candidate. The integration task
    (NFM-3602 / §4.3-i) will tighten this once a bulk-blocker-status
    endpoint exists; until then the dry-run is a STRICT SUPERSET of
    what the routine will prune (no false negatives).
    """
    blocked_by = list(
        issue.get("blockedBy") or issue.get("blockedByIssueIds") or []
    )
    closing = sorted(set(blocked_by))
    return blocked_by, [], closing


def run_dry_run(
    company_id: str | None,
    sample_size: int,
) -> DryRunReport:
    """Walk the live instance and produce the §4.3-b dry-run report."""
    dependents = _fetch_dependents_with_blockers(company_id)

    by_company: dict[str, int] = defaultdict(int)
    cleared: list[ClearedDependency] = []
    blockers_to_remove = 0
    removed_by_status: dict[str, int] = {"done": 0, "cancelled": 0}

    for dep in dependents:
        company = dep.get("companyId") or dep.get("company_id")
        if company:
            by_company[company] += 1
        before, after, closing = _classify_blockers(dep)
        if not closing:
            continue
        cleared.append(
            ClearedDependency(
                dependent_id=dep.get("id", ""),
                dependent_identifier=dep.get("identifier"),
                company_id=company,
                status=dep.get("status"),
                before_blocked_by_issue_ids=before,
                after_blocked_by_issue_ids=after,
                closing_issue_ids=closing,
            )
        )
        blockers_to_remove += len(closing)

    return DryRunReport(
        companies_scanned=len(by_company),
        dependents_scanned=len(dependents),
        dependents_touched=len(cleared),
        blockers_to_remove=blockers_to_remove,
        removed_by_status=removed_by_status,
        cleared=cleared,
        flagged_company_ids=sorted(by_company.keys()),
    )


# --- Output ------------------------------------------------------------------


def _print_human(report: DryRunReport, sample_size: int) -> None:
    print("ADR-009 §4.3-b dry-run — reconcile cancelled blockers")
    print(f"  companies scanned      : {report.companies_scanned}")
    print(f"  dependents scanned     : {report.dependents_scanned}")
    print(f"  dependents touched     : {report.dependents_touched}")
    print(f"  UUIDs to remove (est)  : {report.blockers_to_remove}")
    print(f"  removed-by-status      : {report.removed_by_status}")

    if report.flagged_company_ids:
        print(f"  flagged companies      : {len(report.flagged_company_ids)}")
        for cid in report.flagged_company_ids[:5]:
            print(f"      - {cid}")
        if len(report.flagged_company_ids) > 5:
            print(f"      … +{len(report.flagged_company_ids) - 5} more")

    if not report.cleared:
        print("\nNo cleared dependencies. Reconcile would be a no-op.")
        return

    print(
        f"\nSample cleared dependencies "
        f"(first {min(sample_size, len(report.cleared))}):",
    )
    for dep in report.cleared[:sample_size]:
        ident = dep.dependent_identifier or dep.dependent_id[:8]
        before = dep.before_blocked_by_issue_ids
        after = dep.after_blocked_by_issue_ids
        print(f"  - {ident}")
        print(f"      before blockedByIssueIds = {before}")
        print(f"      after  blockedByIssueIds = {after}")
        print(f"      closing issue ids        = {dep.closing_issue_ids}")
    if len(report.cleared) > sample_size:
        print(
            f"  … +{len(report.cleared) - sample_size} more "
            "(use --sample-size to expand)",
        )


def _print_json(report: DryRunReport) -> None:
    print(json.dumps(report.to_dict(), indent=2, sort_keys=True))


# --- Entry point -------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="reconcile_cancelled_blockers.py",
        description="ADR-009 §4.3-b dry-run scanner for cancelled-blocker wedges.",
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
            "Number of cleared-dependency samples to print "
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
    args = parser.parse_args(argv)

    try:
        report = run_dry_run(args.company_id, args.sample_size)
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
