<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Platform-first delivery policy

## Default decision order
Before writing non-trivial new code, follow this order:

1. Reuse existing project components, modules, templates, utilities, APIs, and tests.
2. Check whether an already-connected specialist platform or MCP tool can do the job safely.
3. Use a mature maintained library or framework feature.
4. Write the smallest possible custom implementation only for missing, project-specific business logic.

Do not rebuild working features, rewrite whole screens, or create parallel systems merely because generating fresh code is easier.

## Tool routing
- **Canva / Figma:** brand assets, design exploration, mockups, approved visual references, marketing material. Do not treat a mockup as production code.
- **Retool / Appsmith:** internal dashboards, admin panels, CRUD screens, tables, forms, review queues, operational uploads and internal reporting. Do not move a customer-facing or tightly integrated existing screen into low-code without explicit approval.
- **Supabase:** prefer its managed database, Auth, Storage, Realtime, migrations, RLS and Edge Functions when the project already uses Supabase or adoption is explicitly approved. Do not invent a second auth or persistence layer.
- **n8n:** scheduled jobs, webhooks and multi-service automations. Keep core transactional and clinical business rules in version-controlled application code.
- **GitHub:** source of truth for code, schemas, integration contracts and deployment configuration.

## Required pre-code check
For every meaningful feature, silently verify:
- Is this already present in the repository?
- Is there an approved component/template for it?
- Is a connected platform actually available and authenticated?
- Would using it reduce code without weakening security, maintainability, ownership or user experience?

If custom code is still needed, state one brief reason in the task summary. Never claim to have used a platform unless its tool/API/MCP was genuinely available and used.

## Cost and quality rules
- Prefer focused patches over broad rewrites.
- Preserve existing architecture unless migration is explicitly requested.
- Avoid unnecessary dependencies and generated boilerplate.
- Use official documentation only when a capability is unclear or version-sensitive; do not browse repeatedly for routine work.
- Keep platform integrations behind documented APIs/contracts so they remain replaceable.
- Run the smallest relevant tests first, then broader tests only when warranted.

## Data safety
Never send identifiable patient, prescription, pharmacy or production data to Canva or other design/prototyping platforms. Use synthetic or de-identified samples. Do not change production databases, credentials, billing, deployment or external platform configuration without explicit approval.
