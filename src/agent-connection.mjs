// Pure connection copy. Nothing here calls a provider or stores a private key.
export function connectionSettings(endpoint, key) {
  return { mcpServers: { nooks: { url: endpoint, headers: { Authorization: `Bearer ${key}` } } } };
}
export function connectionMessage({ agent, endpoint, key, project, system = null }) {
  const isBf = system === 'brainflakes-standard' || system === 'brainflakes';
  const taskLine = isBf
    ? 'Once connected, help me design a Brain Flakes disc build in this Nooks project (system: "brainflakes-standard"). Call brainflakes_catalog and runtime_guide, build with build_program using Brain Flakes ops (disc, attach, ring, connect, close), inspect with view from several angles, and verify with check_model. Fit is geometric; never claim physical retention is verified.'
    : 'Once connected, help me design a custom brick kit from my photo. Ask what I want to build and my size and parts budget. Work in this Nooks project so I can preview it. Check the saved design, then use export_kit for manual steps, the parts list, BrickLink wanted list, parts estimate and the link to buy parts. Tell me if prices or checks are unavailable; never invent them.';
  return `Connect ${agent} to my Nooks build “${project}” using this private MCP connection.

Server: ${endpoint}
Transport: Streamable HTTP
Authorization: Bearer ${key}

If you can add MCP connections, add this server and call read_project to verify access. If you cannot add it yourself, tell me exactly where to paste the server address and Bearer token in this app. Do not say you are connected until read_project succeeds. Keep this key private; do not put it in source files, logs, shared messages or a public URL.

${taskLine}`;
}
