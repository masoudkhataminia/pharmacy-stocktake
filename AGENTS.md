<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Platform-first delivery policy

## Default decision order
Before writing non-trivial new code:
1. Reuse existing project components, modules, templates, utilities, APIs and tests.
2. Check whether a specialist tool can safely provide a higher-quality result with materially less custom code.
3. Prefer a mature maintained library or framework feature.
4. Write only the smallest missing project-specific business logic.

Do not rebuild working features, rewrite whole screens, or create parallel systems merely because generating fresh code is easier.

## Discover beyond currently connected tools
Do not limit discovery to tools visible in the current chat. When useful, consider:
- web SaaS products and specialist websites;
- native macOS, Windows, Linux, iOS or Android apps;
- self-hosted/open-source platforms and Docker images;
- ChatGPT/Codex plugins, MCP servers and connectors;
- APIs, SDKs, CLIs, GitHub Apps and browser/IDE extensions;
- no-code/low-code builders, workflow automation and template/component marketplaces.

Discovery must be focused, not a marketplace-wide search. Do it only when a tool is likely to reduce implementation effort or recurring AI usage by roughly 20% or more, or clearly improve reliability, accessibility, security, testing or visual quality.

## If the best tool is not connected
Do not silently fall back to building everything from scratch. First provide a short **Connection Plan** containing:
1. recommended tool and one practical alternative;
2. why it fits this exact task;
3. free/open-source/self-hosted option where credible;
4. current expected subscription or usage cost and likely lock-in;
5. exact installation/connection path: desktop app, website signup, plugin, MCP, API, CLI, GitHub App, Docker or extension;
6. minimum permissions, credentials and data access required;
7. privacy/security implications and what data must remain synthetic or de-identified;
8. what Codex can prepare before connection and what requires user approval.

Use current official documentation for version-sensitive connection steps. Ask for approval before installing software, creating paid accounts, changing billing, adding secrets, granting access, modifying production, or sending external data. Never request that secrets be pasted into chat; direct the user to the correct secret manager/settings screen.

After presenting the plan, continue any safe preparation that does not create lock-in or touch production, such as schemas, API contracts, mock data, adapters, environment-variable templates and migration plans.

## Selection priorities
Rank suitable tools by:
1. fit and output quality;
2. total ongoing cost, including AI usage and hosting;
3. ability to export data/code and avoid vendor lock-in;
4. compatibility with GitHub and the user's own server;
5. privacy, access control and auditability;
6. maintenance activity and official integration support;
7. ease of use from mobile and desktop.

Prefer existing subscriptions, free tiers, open-source and self-hosted options when quality remains high. Do not add overlapping paid tools without showing the benefit over tools already available.

## Tool routing examples
- **Canva / Figma:** brand assets, design exploration, mockups and approved visual references; mockups are not production code.
- **Retool / Appsmith and equivalents:** internal dashboards, CRUD, tables, forms, review queues, uploads and reporting; do not move tightly integrated customer-facing screens without explicit approval.
- **Supabase and equivalents:** managed database, Auth, Storage, Realtime, migrations, RLS and server functions when adoption is approved; do not invent a second auth or persistence layer.
- **n8n and equivalents:** scheduled jobs, webhooks and multi-service automation; keep core clinical and transactional rules in version-controlled application code.
- **Desktop/API/testing tools:** use suitable database clients, API clients, browser testing, accessibility auditing, container tooling and design handoff apps instead of recreating their capabilities.
- **GitHub:** source of truth for code, schemas, integration contracts and deployment configuration.

## Required pre-code check
For every meaningful feature, silently verify:
- Is it already present in the repository?
- Is there an approved component/template?
- Is a suitable connected tool actually available and authenticated?
- Is a better external website, desktop app, service, extension, API, CLI or self-hosted tool worth connecting?
- Would it reduce code without weakening security, ownership, maintainability or user experience?

If custom code is still needed, state one brief reason in the task summary. Never claim to have used a platform unless its tool/API/MCP/CLI was genuinely available and used.

## Cost and quality rules
- Prefer focused patches over broad rewrites.
- Preserve existing architecture unless migration is explicitly approved.
- Avoid unnecessary dependencies and generated boilerplate.
- Do not repeatedly browse or re-evaluate tools for routine changes once a tooling decision is documented.
- Keep integrations behind documented APIs/adapters so they remain replaceable.
- Run the smallest relevant tests first, then broader tests only when warranted.

## Data safety
Never send identifiable patient, prescription, pharmacy or production data to design, prototyping or external evaluation platforms. Use synthetic or de-identified samples. Do not change production databases, credentials, billing, deployment, installed software or external platform configuration without explicit approval.
