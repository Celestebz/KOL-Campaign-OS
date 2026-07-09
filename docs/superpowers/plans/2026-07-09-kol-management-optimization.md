# KOL Management Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn KOL Management into a compact, filterable master list with a detail drawer and read-only campaign history.

**Architecture:** Keep `customers` as the KOL master and treat `kol_platform_accounts` as the preferred platform-account source. Backend response helpers merge normalized accounts with per-platform legacy fallbacks, while the React page consumes one stable account shape and never merges storage formats itself.

**Tech Stack:** Express, MySQL/Sequelize raw queries, Node test runner/Supertest, React 18, Ant Design 5, Axios.

---

### Task 1: Customer route contract and tests

**Files:**
- Create: `server/routes/customers.test.js`
- Modify: `server/routes/customers.js`

- [ ] Write failing route tests for platform-account precedence/fallback, filters, options, recent projects, and project history.
- [ ] Run `cd server && node --test routes/customers.test.js`; expect the endpoint assertions to fail.
- [ ] Implement compatible platform accounts, list filters/options, recent projects, detailed customer responses, and project history.
- [ ] Re-run the focused tests; expect all tests to pass.

### Task 2: Compact list and detail drawer

**Files:**
- Modify: `client/src/pages/Customers.js`
- Modify: `client/src/index.css`

- [ ] Add filter, statistics, drawer, detail/history, and stale-request state.
- [ ] Replace the wide table with the approved columns and add the detail drawer.
- [ ] Preserve the existing edit modal and refresh list/drawer after successful edits.
- [ ] Run `npm run build`; expect a successful production build.

### Task 3: Regression verification

- [ ] Run `cd server && npm test`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Confirm the original workspace's Finder edits remain untouched.
