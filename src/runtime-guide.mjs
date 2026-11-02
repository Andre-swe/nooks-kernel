// What an agent reads before it builds with programs (lib/program.mjs): the units, the connectors and how they
// pair, the ops with worked examples, and how to work. The construction model and its rules are BrickAgent's
// (MIT, Kulits 2026), so its examples translate op for op.
export const GUIDE = `# Building part by part

You place real parts by their connectors, the way a designer builds. A program is JSON: { "name": …, "ops": [ … ] }. The
server runs it, checks it (exact joins, collisions, inventory, stability), and saves the result as a model a person can
open, edit by hand, share and order. Every part you can find, describe and place is sold loose, in the colours it is
sold in, so anything you build can be ordered as a kit; a part or colour that is not is refused with the closest one
that is. Your program is kept with the revision, and export_python gives any revision as a BrickAgent script.

## Building instructions
Read with read_instructions and check_instructions (six weighted checks, 0–100).
Explore with try_instructions without saving; render_instructions shows up to four pages.
Save with edit_instructions, or reset with plan_instructions. Supply baseRevision and reason;
replaceHumanEdit explicitly permits replacing a human head. Agent credit is recorded.
Ops: split, merge, move, reorder, view/reset, rotateIcon, subassembly, note/clear,
arrow/clear, page, pageBreak, big, cover, bom, highlight, rename, replan, repair.
Steps start at 1; parts use keys. Review refusals and inspect pictures after scoring.

## Units and frame
LDraw units and axes: x and z across, **-y up**. A stud is 20, a plate 8, a brick 24. Poses are lists composed left to
right, as at(x=1) @ spin(UP, 90): [{ "at": [x, y, z] }] in studs/plates/studs, [{ "move": [x, y, z] }] in LDU,
[{ "spin": ["up", 90] }] or [{ "spin": [[0, 0, 1], 45, [0, 0, 0]] }] (right-handed degrees about an axis, optionally
through a point). A pose places a part's origin, not its bounds; describe_part gives both.

## Connectors
Each part's connectors have addresses by type and index: stud[0], hole[3], pin[1], socket[-1] (negative counts back).
| Pair | Fit |
| --- | --- |
| stud / open <-> hole / tube | turns (yaw) about the stud |
| open <-> post | a hollow stud over a post |
| pin / axle <-> socket | round Technic hole: flip, yaw, slide |
| axle <-> cross | cross-shaped hole: flip, yaw, slide |
| bar <-> clip / cross | round bar: flip, yaw, slide |
| hinge <-> hinge | flip, yaw (same subtype, polarity in to on) |
| ball <-> ball | any rotation about the ball's centre |
| fixed <-> fixed | its labelled pose only |
describe_part prints a part's connectors with positions and axes; a 2xN brick's stud[2i] and stud[2i+1] are column i.
Standard bricks run along x; Technic beams along z.

## Ops
- { "op": "add", "name": "left", "part": "brick 1x1", "pose": [ … ], "color": "tan" }: a part by LDraw number or a
  family-first name ("plate 1x3", "minifig axe"). A part placed with add must sit exactly on the studs it rests on;
  attach does that arithmetic for you, so attach wherever there is a stud.
- { "op": "attach", "name": "span", "part": "plate 1x3", "to": "left.stud[0]", "by": ["hole", 0], "orient": [],
  "color": "red" }: to is a connector already placed; by is the new part's connector (leave it out when exactly one
  fits). Options: "yaw" (degrees about the joint axis), "flip", "slide" (LDU, axle joints), "seat" ('auto' seats pin
  collars), "align": [u, v] (point the part's local u along v), "orient": a pose (the whole rotation; [] keeps the
  part square to the model even when the target is turned). Attachments never move existing parts.
- { "op": "contact", "a": "span.hole[2]", "b": "right.stud[0]" }: a second join the checks must find (a span across two
  supports, a loop closed).
- { "op": "define", "name": "unit" } … { "op": "end", "returns": { "pin_end": "pin.pin[1]" } }: a reusable
  assembly. Place copies with { "op": "add", "use": "unit", "pose": … } or attach one by a returned connector:
  { "op": "attach", "use": "unit", "to": …, "by": "pin_end" }. Inside a copy, reach a returned connector as
  "copyname:pin_end". Copies share their definition.
- { "op": "mirror", "name": "right_wing", "of": "left_wing", "axis": "x" }: a mirrored copy through the parent's
  x = 0 plane (or "about": [x, y, z]), using each part's native left/right counterpart.
- { "op": "base", "revision": "latest" } (first op only): start from a saved revision — a person's hand edit in the
  workbench, a sketch, an imported file — every part placed where it is and named p0, p1, … so you can attach to
  them (program_connectors lists where a part's connectors are). Saved models stand on y = 0 (a brick's top at -24).
- Connector references: "name.stud[0]", "name.socket[-1]", "name.hole.near(x, y, z)" (the nearest of that type to a
  point in the model's frame), "copy:returned".

## Examples
A bridge over two supports:
{ "name": "bridge", "ops": [
 { "op": "add", "name": "left", "part": "brick 1x1", "color": "tan" },
 { "op": "add", "name": "right", "part": "brick 1x1", "pose": [{ "at": [2, 0, 0] }], "color": "tan" },
 { "op": "attach", "name": "span", "part": "plate 1x3", "to": "left.stud[0]", "by": ["hole", 0], "orient": [], "color": "red" },
 { "op": "contact", "a": "span.hole[2]", "b": "right.stud[0]" } ] }
A pinned beam reused twice and linked:
{ "name": "links", "ops": [
 { "op": "define", "name": "pinned_beam" },
 { "op": "add", "name": "beam", "part": "technic beam 5" },
 { "op": "attach", "name": "pin", "part": "2780", "to": "beam.socket[-1]", "by": ["pin", 0], "align": [[1, 0, 0], [0, -1, 0]] },
 { "op": "end", "returns": { "pin_end": "pin.pin[1]" } },
 { "op": "add", "name": "left", "use": "pinned_beam", "color": "yellow" },
 { "op": "add", "use": "pinned_beam", "pose": [{ "at": [8, 0, 0] }], "color": "blue" },
 { "op": "attach", "part": "technic beam 3", "to": "left:pin_end", "by": ["socket", 0], "flip": true, "yaw": 30 } ] }
A minifigure: hips 3815b; legs 3816c and 3817c on hips.hinge[0] and [1] by ["hinge", 0] (a yaw of 270 on one leg and
90 on the other sits it down); torso 973 on hips.fixed[1] by ["fixed", 0]; arms 3818 and 3819 on torso.hinge[0] and [1]
by ["hinge", 0] with a yaw (240 and 230 hang them forward); hands 3820 on each arm's hinge[1]; head 3626b on
torso.pin[0] by ["socket", 0]; hair or a hat on head.open[0]; a tool's bar in a hand's clip[0].
A side stud (SNOT): attach a round plate's tube[0] to "holder.open[0]" of a brick 1x1 with stud on 1 side (87087).

## Writing code
run_code runs Python against BrickAgent's own API, so loops, variables and arithmetic work, and a placement is a live
object: Assembly, at, move, spin, UP, ID, Pose, check, parts, connections, attachments, measure are already imported.
Leave the model in m. It runs in a sandbox of its own (no network, 30 s, 1.5 GB); the model comes back as a build program
(every part at its pose, sub-assemblies as definitions, attachments as joins the check looks for), checked as
check_program checks one, with what the code printed. save: true keeps the code with the revision.
m = Assembly("tower")
last = m.add("3001", color="red")
for i in range(9):
    last = m.attach("3001", to=last.stud[0], by=("hole", 0), color="red" if i % 2 else "white")
wing = Assembly("wing")
root = wing.add("3020", color="dark bluish gray")
wing.attach("3021", to=root.stud[7], by=("hole", 0), color="red")
m.add(wing, pose=at(6, -30, 0))
m.add(wing.mirror("x"), pose=at(-6, -30, 0))
Connectors: last.stud[0], last.stud.near((10, -24, 10)), copy.connector(reference_in_its_definition).

## Checks and physics
Joins, collisions and stability are BrickAgent's own check (BrickNet's colliders, two seconds of gravity in PyBullet,
3 LDU allowed), run by BrickAgent in a sandbox: checks.physics.engine says "pybullet". If that sandbox cannot run, the
workbench's engine answers (engine "rapier"): the same colliders' shapes and rule, another engine, so a build at the
edge can pass one and not the other. test_gravity is the workbench's own test, the one a person runs. A check that runs
past its time is incomplete, never a pass.

## Live sessions
Your connection has a live model: build it up with session_ops (ops) or run_code with live: true (code cells whose
variables stay for the next cell), ask it anything with session_query (measure, parts, connections, connectors, check,
view), take steps back with session_undo, and save it with session_save when it is right. It is kept between calls and
across reconnects. If the person saves in the workbench meanwhile, session_save refuses until session_rebase puts your
model on top of their edit. session_reset clears it.

## Whose builds
You work for a person. With their account key, list_builds shows the builds you may open; open_build picks one (every
later call works on it, and you can switch), create_build starts one. Everything you save is marked as their agent's.
A read-only key is offered only the tools that change nothing. A build's own key opens that one build.

## How to work
1. find_parts and describe_part for parts you do not know; filter by their connectors. parts_that_fit lists the parts
   with a connector that joins a given one (a stud, a pin hole, a clip), the most used first.
2. Write the program; run check_program as you go (stability false for a part-built piece). Every problem names the
   parts and connectors involved. program_connectors shows where a placement's connectors are and which are free or
   joined (and to what): build next on the free ones. It takes a part inside a copy of an assembly as "copy/inner".
   Give check_program, build_program or edit_program an inventory ({ "3001": { "Red": 8 }, "3020": null }) when you
   may only use certain parts; every part used past it is named.
   Run simulate_program for imported convex-mesh collisions and a two-second gravity test. Each connected group
   is rigid; maximum vertex movement must stay within 3 LDU. This is Rapier, not a claim of identical PyBullet
   results. Connections do not bend or break. Missing meshes and timeouts mean incomplete, never passed.
   test_gravity runs the same test on a saved revision (a person's build too) and lists what overlaps, falls or
   tips, with the parts and what would fix each, as the person sees it in the workbench.
3. Look at the model with view from several angles (the automatic camera is a three-quarter view from the front;
   the back: azimuth 210). Passing the checks is not enough: experienced designers judge form, proportion, surface,
   and parts chosen for the shapes they make. Refine until it reads as its subject.
4. Save with build_program (baseRevision: the project's currentRevision). Change it later with edit_program.
   Use finalize_model with that explicit revision for one bundle of checker, full collision/gravity test,
   front/back renders and LDraw export. It never saves or publishes; inspect its status and missing evidence.
   Final views, check_model and export_ldraw must specify the same returned revision, never independently use latest.
   Saved checks carry revision and modelHash. Missing assets or omitted parts mean incomplete, never a pass.
   view diagnostic: true colours connected components and returns their flattened part paths; it preserves poses
   and saved colours. Component colours repeat after eight groups; use membership metadata for identity.
Stability: each connected group of parts is a rigid body. It must rest on the ground or on groups standing beneath it,
with its weight over what holds it up. The ground is the lowest point of the model, so everything free-standing must
reach down to it. Touching is not joining: a part only joins when its studs sit fully in the holes above.

## Places
read_place gives a real square of the world from OpenStreetMap at the scale you ask: a grid of the ground, one character
a stud (row 0 the north edge, column 0 the west; its legend and the colours to build each kind of ground in), and each
building as rows of studs [row, first column, last column], its height in plates (walls and top; 3 plates a brick), wall
colour, roof shape and colour. You design the model; the map says what is there. A cell (row j, column i) on a base of
N studs sits at at(i - N/2 + 0.5, …, j - N/2 + 0.5). Work as a set designer would, in code:
- Ground: tiles or plates on the base in the ground's colours, roads a little lower than pavement, water in blue or trans
  blue; merge runs of cells into the longest plates that fit.
- Buildings: walls one stud thick around each footprint, bricks staggered course to course so the walls hold, hollow
  inside; rows of windows (transparent or the windows colour) every storey; the roof as tagged (slopes for gabled and
  hipped, tiles for flat); at small scales a building can be solid.
- Landmarks deserve detail; most buildings read best simple and in their real colours. Untagged colours are guesses.
- Trees: a brown 1×1 round trunk and a green crown at their height.
- Credit "Map data © OpenStreetMap contributors" in the build's name or notes wherever it is shown.

## Brain Flakes construction system (system: "brainflakes-standard")
Brain Flakes builds use one standard eight-slot interlocking disc (~32.4 mm diameter, 2.5 mm thick, slot roots at 9.894 mm radius, 45° apart: slots 0..7).
- **Colours** (catalogue ids only): \`red\`, \`orange\`, \`yellow\`, \`light-green\`, \`dark-green\`, \`light-blue\`, \`dark-blue\`, \`purple\`, \`pink\`, \`brown\`, \`white\`, \`black\`.
- **Standard set**: \`jar-500\` (500-piece jar, evenly mixed across the 12 colours: 41–42 per colour).
- **Legal mating poses**: \`pose: 0\` (roll 90°) and \`pose: 1\` (roll 270°, the opposite flip) are the two perpendicular slot-to-slot poses derived from the mesh press-fit check (seated centres 19.79 mm apart). Fit is a geometric finding; holding strength is not simulated.
- **Declarative build program** (\`system: "brainflakes-standard"\`), checked and run as data (never executed code):
  \`{ "system": "brainflakes-standard", "name": "Flower", "set": "jar-500", "ops": [\`
  \`  { "op": "disc", "name": "centre", "color": "yellow" },\`
  \`  { "op": "ring", "prefix": "petal", "color": "pink", "to": "centre", "slots": [0,1,2,3,5,6,7], "by": 0, "pose": 0 },\`
  \`  { "op": "attach", "name": "stem1", "color": "light-green", "to": "centre.slot[4]", "by": 0, "pose": 0 },\`
  \`  { "op": "close" }\`
  \`] }\`
- **The standard you are held to:** experienced builders will judge your design beside good published Brain Flakes models, on form, proportion, colour and how cleverly the discs make the shapes. Every requested object, part and relation must be recognisable from the renders. Passing the checks is necessary but nowhere near sufficient: render from the front, the side, the back (\`az: 210\`) and above, say plainly what reads wrong, fix it, and repeat until it reads clearly. Spend your budget on refining, not on stopping early.
- **Techniques (\`brainflakes_technique\`):** one part with 90° joints means every shape comes from technique. Call it with no name to list them, then with a name and size to get a tested \`define\` op; paste it into \`ops\` and place copies with \`instance\`. \`beam\`: a straight run (limbs, rails, edges). \`post\`: a vertical column on a foot (legs, pillars). \`panel\`: a flat rigid grid (decks, floors, bases; spin it upright for walls and bodies). \`arc\`: a planar curve, 45° every two discs (arches, backs, tails). \`ring\`: eight discs round a hub (flowers, wheels). \`block\`: a solid interlocked volume (bodies, heads, piers, towers); use odd widths and depths (3 or 5) when it must be symmetric. Every technique result lists \`faces\` (free slots pointing out of each side, with positions) and \`mirrorSymmetric\`: attach matching limbs at mirrored face slots, or with \`toward\`. **Shaping solids with \`sculpt\`:** list the cells of any shape (body, neck and head in one piece, tapered, curved, hollow) as \`{"cells":[[i,j,k],[i,j,k,"black"],...]}\`; every cell is filled on one lattice and joined, with no stacking or centring to work out. Add \`"shell": 2\` to keep only a two-cell skin: big forms become hollow and far lighter but stay one interlocked piece (one cell is too thin to hold together). The lattice: cells are 19.788 mm apart; parity (i,j,k mod 2) decides the disc: 000 and 111 lie flat, 010 and 101 face ±X, 011 and 100 face ±Y, 001 and 110 are always empty. So a feature that must face the viewer (an eye, a patch, a marking) is a surface cell whose parity faces that way, given its own colour. Blocks and sculpts share this lattice: pieces placed without moving them join with \`close\`. Techniques are tested starting points, not a style: change, combine or ignore them. **Volume:** a model one disc thick looks like a wire sketch and goes flat from the side; check the side view (\`az: 90\`) and give the main masses depth where the subject has it.
- **How Brain Flakes shapes read (design language):** a model is read as silhouettes, planes and colour, not as parts. A disc seen face-on reads as a solid round patch; seen edge-on it is a 2.5 mm line, so turn discs to face the main view where you want mass and edge-on where you want an outline. One well-placed disc can be a whole feature: a beak, an eye, an ear, a fin, a leaf, a wheel. Repeated discs read as a material: a field of flat blue discs is water, a spray of green is foliage, a stack is a trunk. Colour carries more meaning than shape: one main colour, one or two accents for features, nothing stray. Suggest the subject with the fewest discs that make it unmistakable, then add only what improves the read. These are observations about the medium, not a recipe; the design decisions are yours.
- **Accents make the model:** a filled volume reads as a block; character comes from a few single discs placed one by one after the mass is right. Shape the silhouette first (narrow the neck, taper the top, widen the base), then add accents: ears as two discs angled outward with an inner colour, whiskers as thin edge-on white discs, a tail as a curving chain ending in a contrasting tip, eyes as one face-on disc each. Check each accent from the front and the side; remove any that do not read.
- **Loose parts are allowed:** discs need not all be joined. A disc can rest on the floor or on other discs (water, ground, scattered petals, a figure standing on a base); within 0.1 mm of touching counts as resting contact, reported as \`designed-resting-contact\`. A part touching nothing below it is floating. The checks only estimate support; run \`test_gravity\` on the saved build for the final word, and give resting parts broad overlaps: a slot notch under a contact point gives no support.
- **Orientation (measured from the compiler):** a root \`disc\` lies flat in the XY plane (normal +Z) centred on its \`at\`. Slot k points outward at 45·k° in the disc's plane: on a flat root slot 0 is +X, 2 is +Y, 4 is −X, 6 is −Y.
- **Where an attached disc goes:** \`attach\` always seats the child perpendicular to its parent, its centre 19.79 mm out along the parent slot. The child's plane contains that slot direction and the parent's normal, so on a flat parent every child stands upright. \`by\` names the child slot used for the joint; the slot opposite it (\`by+4\`) points straight on, outward. \`pose\` picks which face of the child faces which way (pose 1 flips it), shifting the child 1.25 mm either side of the parent plane.
- **Attach by direction:** instead of a slot number, write \`{ "op":"attach", "name":"leg1", "to":"hip", "toward":[0,0,-1] }\`: the free slot of \`hip\` pointing within 22.5° of that world direction is used, or the op fails saying none does (a disc's slots lie in its own plane) or that it is occupied. Add \`"facing":[0,1,0]\` to choose the pose whose new disc faces the viewer along that axis.
- **Continuing a chain:** the next disc goes on the child's outward slot, \`by+4\` (with \`by: 0\`, \`child.slot[4]\`); the joint slot \`by\` is already occupied.
- **Going up and down:** on an upright child attached with \`by: 0\` at \`p.slot[0]\` of a flat parent, with \`pose: 0\` its slot 2 points −Z (down) and slot 6 points +Z (up); with \`pose: 1\` slot 2 points up and 6 down. Attach there to continue vertically. Deeper in a chain directions depend on each disc's own pose, so read them from \`inspect_brainflakes\` or \`program_connectors\` (each slot's \`outward\`) rather than assuming the same slot. Each further attach turns 90° again, so a straight chain alternates flat and upright discs and zig-zags ±1.25 mm.
- **Free placement:** \`at: [x,y,z]\` in mm places the disc's bottom face; a flat disc's centre is 1.25 mm above it. The floor is the lowest point of the model (reported as \`groundZMm\`), so upright discs can reach below a flat deck. Placement options: \`spin: [["x",90],["z",45]]\` (applied in order), or \`transform: {"r":[row-major 3×3 rotation],"t":[x,y,z]}\`, e.g. \`{"r":[1,0,0,0,0,-1,0,1,0],"t":[0,0,20]}\` stands a disc upright in the XZ plane.
- **Reading checks:** in \`check_program\` read \`checks.ok\` and \`checks.issues\` first; the rest is supporting evidence.
- **Errors:** when an op fails, later ops that use a disc it would have created report \`Skipped: … because op N failed\`; fix op N first.
- **Build with code:** for anything beyond a few discs, write the design as a Python script in \`run_code\` (\`BrainFlakes()\` is preloaded; leave the model in \`m\`). Use loops, functions and arithmetic; read live geometry as you go (\`d.center\`, \`d.normal\`, \`d.slot[k].outward\`, \`m.free_slots()\`, \`m.nearest_connector(point)\`, \`m.measure()\`, \`m.check()\`); attach by direction with \`m.attach('leg', hip, toward=[0,0,-1], facing=[1,0,0])\`; fill a cell shape with \`m.sculpt([[0,0,0],[1,0,0,"black"]], color="orange", shell=2)\` (the sculpt lattice); paste a technique's \`define\` with \`m.op('define', **d)\`. Keep one script, rerun and refine it, look at each run from several angles with \`views: [{"az":30,"el":25},{"az":120,"el":10}]\` (no save needed), and save from it (\`save: true\`, \`baseRevision\`, \`reason\`). JSON \`ops\` suit small edits and quick checks.
- **Workflow:** \`check_program\` and \`view\` (several \`az\`/\`el\` angles) a program, \`inspect_brainflakes\` with \`compact: true\` for centres and normals only, then save with \`build_program\` (pass the project's \`currentRevision\` as \`baseRevision\`; it is \`null\` before the first save) or build in a live session with \`session_ops\` and \`session_save\`.
- **Ops**: \`disc\` (root disc), \`attach\` (\`to: "disc.slot[i]"\`, \`by: 0..7\`, \`pose: 0|1\`), \`ring\` (attach to several slots at once), \`connect\` (join two free slots that already line up), \`close\` (connect every lined-up free slot pair).
- Disc native XY is its plane; native Z is up in the workbench. Root discs can use \`at\`, \`spin\` or a rigid \`transform\` in millimetres.
- Define a reusable local assembly with \`{ "op":"define", "name":"panel", "ops":[{ "op":"disc", "name":"root", "color":"yellow" }] }\`. Place a copy with \`{ "op":"instance", "name":"left", "of":"panel", "to":"hub.slot[0]", "by":"root.slot[0]" }\`; its disc is addressed as \`left-root.slot[0]\`. Free copies may use a rigid transform. \`mirror: "x"|"y"|"z"\` reflects a definition in its local frame; it assumes the standard CAD disc is mirror-symmetric and still needs mesh checking.
- \`remove\` and \`recolor\` apply to named discs. \`inspect_brainflakes\` reports poses and slots and can test reflection symmetry; \`view\` can project free and occupied connector markers. Live session rebase merges supported disjoint edits and can recover some exactly replayable flattened histories; unsafe or ambiguous cases are refused.
- \`run_code\` uses an isolated microVM with preloaded \`BrainFlakes\`: e.g. \`m = BrainFlakes('flower'); hub = m.disc('hub'); m.attach('petal', hub.slot[0], color='pink')\`. Methods \`disc\`, \`attach\`, \`ring\`, \`connect\`, \`define\`, \`instance\` and \`op\` emit a program that Nooks recompiles and checks. Use \`live: true\` for stateful cells; inspect them with \`session_query\`. The local development worker is not accepted as an isolation boundary for this tool.
- \`test_gravity\` estimates rigid-body motion on a saved revision of up to 5,000 discs. Larger assemblies use sampled floor hulls and approximate slot-aware contact between components; results can be incomplete. Some runs stop early when bodies sleep or exceed the movement threshold: read the reported seconds and extrapolation, not just the status. For a difficult build, \`effort: "extended"\` allows up to 60 seconds of simulation work and a 90-second worker deadline; set the MCP request timeout to at least 120 seconds. Neither mode verifies snap-fit or retention.
- Pass a Brain Flakes program to \`check_program\`, \`view\`, \`build_program\` or \`edit_program\` (or set \`system: "brainflakes-standard"\` on \`create_build\`).
`;

// The Brain Flakes section alone, for Brain Flakes projects.
export const BRAINFLAKES_GUIDE = `# Building with Brain Flakes

` + GUIDE.slice(GUIDE.indexOf('## Brain Flakes construction system'));
