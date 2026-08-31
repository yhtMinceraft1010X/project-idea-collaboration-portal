# BRD: Digital Hub Technical Knowledge & Collaboration Platform
Data Sensitivity: Internal | Date: 2025-01-09 | Owner: Digital Hub Programme Centre
approved_at: 2025-01-09T00:00:00Z

## Functional Scope

| ID | Capability | Source | Priority |
|----|----|----|----|
| FR-01 | System must enable users to submit new problems/explorations via free-form text entry | Explicit | Must |
| FR-02 | System must capture and index 6 core entity types: Problems, Initiatives, Solutions, Findings, Assets, SME Profiles | Explicit | Must |
| FR-03 | System must perform real-time semantic (NLP-based) overlap detection across active initiatives within 2 weeks of new initiative registration | Explicit | Must |
| FR-04 | System must send automated overlap notifications to Initiative Leads + Portfolio Leads + relevant SMEs within 24 hours of detection | Explicit | Must |
| FR-05 | System must display overlap detection results as "smart nudges" in UI, categorising matches as Strong, Partial, or Novel | Explicit | Must |
| FR-06 | System must enable 1-click collaboration setup between overlapping initiatives (booking SME office hours or linking project RFCs) | Explicit | Must |
| FR-07 | System must support manual contribution via structured templates (ADR, Solution, Findings templates) | Explicit | Must |
| FR-08 | System must support manual contribution via free-form uploads (PDFs, Confluence links, GitHub links) | Explicit | Must |
| FR-09 | System must auto-ingest findings from Jira (resolution summaries, status changes) via webhook/scheduled sync | Explicit | Must |
| FR-10 | System must auto-ingest findings from Confluence (pages tagged with initiative/outcome tags) via scheduled sync | Explicit | Must |
| FR-11 | System must auto-ingest assets from GitHub (PR descriptions, commits, issue closures, code/design artifacts) via webhook | Explicit | Must |
| FR-12 | System must require Content Reviewer approval for all manual submissions before publication | Explicit | Must |
| FR-13 | System must auto-index auto-ingested content (from Jira/Confluence/GitHub) after basic validation, without Content Reviewer approval | Explicit | Must |
| FR-14 | System must enable full-text + semantic search across all entity types | Explicit | Must |
| FR-15 | System must return at least one relevant result in top 3 results for 80% of discovery queries (SC-01) | Explicit | Must |
| FR-16 | System must automatically match guidance requests to 1–3 relevant SMEs based on expertise profile + past contributions | Explicit | Must |
| FR-17 | System must notify matched SMEs via Slack/Teams when routed a guidance request | Explicit | Must |
| FR-18 | System must log all SME routing events for audit trail and expertise credibility tracking | Explicit | Must |
| FR-19 | System must maintain SME profiles linked to internal directory, including expertise domains, past contributions, availability | Explicit | Must |
| FR-20 | System must track problem status lifecycle (open, in-progress, solved, archived) | Explicit | Must |
| FR-21 | System must enable Initiative Leads to link initiatives to existing problems and log outcomes/solutions upon project completion | Explicit | Must |
| FR-22 | System must enable Portfolio Leads to view active initiative portfolio with overlap hotspots and dependency mappings | Explicit | Should |
| FR-23 | System must enable Senior Management to view portfolio analytics dashboard (themes, gaps, reuse rate, overlap hotspots) updated weekly | Explicit | Should |
| FR-24 | System must display knowledge graph visualisations showing relationships between problems, initiatives, solutions, and dependencies | Explicit | Should |
| FR-25 | System must capture and index lessons learned, architectural decisions, and proven approaches from completed initiatives | Explicit | Should |
| FR-26 | System must track reuse events (when new initiatives cite prior work) to measure reuse rate (SC-05 metric) | Explicit | Should |

## User Base

| User Type | Internal/External | Est. Concurrent | Auth Method Expected |
|----|----|----|----|
| Initiative Lead / Team Lead | Internal | 20–30 | SSO (internal directory) |
| Technical Contributor / Individual Contributor | Internal | 40–60 | SSO (internal directory) |
| Subject Matter Expert (SME) / Specialist | Internal | 5–10 | SSO (internal directory) |
| Enterprise Architect / Principal Engineer | Internal | 2–4 | SSO (internal directory) |
| Content Reviewer / Moderator | Internal | 2–3 | SSO (internal directory) |
| Portfolio Lead / Programme Manager | Internal | 5–10 | SSO (internal directory) |
| Senior Management / Strategy Lead | Internal | 1–2 | SSO (internal directory) |
| Platform Operator / System Owner | Internal | 1 | SSO (internal directory) |
| **Total** | **Internal** | **50–150 concurrent** | **SSO required** |

## Scale & Usage Patterns

| Metric | Baseline | Peak | Growth (12mo) |
|----|----|----|----|
| Concurrent users | 50 | 150 | +100% (to 300) |
| Initiative registrations per month | 10–15 | 25–40 | +80% |
| Manual contributions per month | 5–8 | 15–20 | +150% |
| Auto-ingested items per month (Jira+Confluence+GitHub) | 50–100 | 200–300 | +200% |
| Search queries per day | 100–150 | 400–600 | +100% |
| Overlap detections per month | 2–4 | 8–12 | +150% |
| SME routing requests per month | 10–20 | 50–80 | +200% |

## Data Characteristics

| Data Type | Sensitivity | Volume (est) | Retention | PII? |
|----|----|----|----|
| Problems | Internal | ~500–2000 over 12mo | 3 years (archived after solved) | Minimal (creator reference only) |
| Initiatives | Internal | ~150–400 over 12mo | Permanent (linked to portfolio history) | Minimal (team owner reference) |
| Solutions | Internal | ~100–300 over 12mo | Permanent (reusable asset) | Minimal |
| Findings | Internal | ~200–600 over 12mo | Permanent (knowledge base) | Minimal |
| Assets (code/templates/designs) | Internal | ~300–1000 over 12mo | Permanent (reusable) | Minimal |
| SME Profiles | Internal | ~50–100 | Permanent (synced from directory) | Yes (name, email, role, expertise domain) |
| Search logs / audit trail | Internal | ~50K–200K events/month | 2 years | Yes (user ID, query, timestamp) |

## Integration Points

| System | Direction | Protocol | Hosted | Data Exchanged |
|----|----|----|----|
| Jira | Inbound | REST API / Webhook | Cloud or On-Prem | Initiative status, resolution summaries, project metadata, issue closures, custom fields (tags) |
| Confluence | Inbound | REST API / Scheduled Sync | Cloud or On-Prem | Page content, metadata, tags, labels, modification timestamps |
| GitHub | Inbound | REST API / Webhook | Cloud (github.com) or On-Prem (GHE) | PR descriptions, commit messages, issue closures, code artifacts, release notes, repository metadata |
| Internal Directory (LDAP/AD/HR system) | Inbound | LDAP / REST API / Scheduled Sync | On-Prem | User identity, email, role, organisational unit, team affiliation (for SME profile enrichment) |
| Slack / Microsoft Teams | Outbound | REST API / Webhooks | Cloud | Overlap notifications, SME routing requests, collaboration setup confirmations, nudges |

## Non-Functional Requirements

| ID | Requirement | Target Metric | Priority |
|----|----|----|---|
| NFR-01 | Discovery query response time | < 3 seconds for 95% of queries (including semantic re-ranking) | Must |
| NFR-02 | Overlap detection latency | System completes scan within 2 weeks of new initiative registration; notification sent within 24 hours | Must |
| NFR-03 | SME routing latency | Match + notify SME within < 1 hour of guidance request | Must |
| NFR-04 | Search result relevance | 80% of discovery queries return at least one relevant result in top 3 (SC-01) | Must |
| NFR-05 | Overlap detection accuracy | System detects 90% of overlapping initiatives; Portfolio Leads manually validate 60% (SC-02) | Must |
| NFR-06 | Guidance self-service availability | 80% of guidance requests resolved from existing knowledge assets without expert escalation (SC-03) | Must |
| NFR-07 | Content capture coverage | 95% of completed initiatives have findings/outcomes captured within 4 weeks of closure; 70% of ongoing initiatives share intermediate findings (SC-04) | Should |
| NFR-08 | Portfolio dashboard freshness | Leadership dashboard updated weekly with themes, gaps, overlaps, reuse rate (SC-05) | Should |
| NFR-09 | System availability | 99.5% uptime (SLA) during business hours | Should |
| NFR-10 | Search index freshness | Auto-ingested content indexed within 24 hours; manual submissions within 2 hours of approval | Should |
| NFR-11 | Concurrent user capacity | System must support 150 concurrent users without performance degradation | Should |
| NFR-12 | Data consistency | All integrations synced within 24 hours; no stale data older than 48 hours | Could |

## Compliance & Audit Requirements

- [x] **Full audit trail required:** Yes. All CRUD operations on core entities, user actions (searches, submissions, approvals, routing), and integration sync events must be logged.
- [x] **Data residency:** Internal network / on-premises data centre (not cloud public internet).
- [x] **Regulation:** No specific external regulation; internal governance: Data Sensitivity = Internal. Access limited to authenticated internal users only.
- [x] **Log retention:** 2 years for audit logs; 3 years for archived problems/findings.
- [x] **SME consent:** SME profiles must comply with internal directory privacy policies. Email notifications require opt-in or system default per org policy.

## Constraints

| ID | Constraint | Type |
|----|----|---|
| CON-01 | Integration dependencies on Jira, Confluence, GitHub — system cannot go live until all 5 integrations are tested and validated | Technical/Schedule |
| CON-02 | SME profile data must sync from internal directory only; no manual SME registration outside of directory | Data/Governance |
| CON-03 | Content Reviewer workload may become bottleneck if submission volume exceeds 20/day; review SLA must be < 24 hours | Operational |
| CON-04 | NLP-based overlap detection requires training on historical initiative data; initial model accuracy may be lower until sufficient corpus is available | Technical |
| CON-05 | Slack/Teams integration requires bot tokens + channel management; notification spam risk if overlap threshold is too low | Technical/UX |
| CON-06 | GitHub integration complexity varies by repo structure; metadata extraction may require custom parsing for some repos | Technical |
| CON-07 | Auto-ingestion from external systems is asynchronous; consistency between Jira/Confluence/GitHub and platform knowledge graph depends on sync frequency | Technical |

## Out of Scope

- Custom workflow engines or process orchestration (this is a discovery + collaboration platform, not a project management system).
- Real-time co-authoring or collaborative document editing (system indexes outcomes; editing happens in source systems).
- AI-generated content recommendations or bot-generated insights (system is knowledge repository + discovery layer, not generative AI).
- Mobile app (MVP is web-based only; mobile may be future iteration).
- Custom reporting engine (dashboard is pre-built analytics; ad hoc reporting requires export to BI tools).
- Direct cost allocation or budget management (Portfolio view tracks initiatives and overlaps; budget tracking is separate financial system).
- Compliance automation (audit trail supports compliance reviews; active enforcement/blocking is not in scope).
