# Forma Anatomy Atlas

Explore adult female and male reference anatomy, isolate structures, inspect cutaways, and study vascular branching at several scales.

Run the application from the repository root with `python3 -m http.server 8080 --directory dist`, then open http://localhost:8080. All viewer assets are included. Source references and licensing are in [the model credits](dist/credits.txt) and the individual vascular study pages.

## Rendering

- **Tissue materials** (`dist/tissue-materials.js`): each structure is classified by name and system (bone, enamel, cartilage, tendon, muscle, artery, vein, nerve, brain, lung, liver, gut, fat, skin, …) and shaded with a physically based material with clearcoat (wet tissue), sheen, and procedural 3D surface detail: muscle fibre streaks along each muscle's principal axis, bone porosity, skin pores, glandular/fat lobules. Detail octaves fade in by on-screen pixel size, so zooming in keeps revealing finer surface relief without shimmering at a distance. Bump normals use analytic noise gradients (no screen-derivative blockiness).
- **Lighting**: image-based lighting (RoomEnvironment PMREM), key/fill/rim lights, ACES tone mapping, and screen-space ambient occlusion (N8AO) with a radius that scales with zoom. MSAA on the beauty pass.
- **Full-resolution geometry** (`dist/detail-loader.js`): the base model is simplified (~2.3M male / 1.9M female triangles) so the whole body loads fast. When the camera is close, regions in view stream the *unsimplified* source meshes (6.7M / 5.6M triangles) and swap them in place. The badge under the orientation menu shows progress. Rebuild with `node tools/build-detail.mjs models <obj dir>` or `node tools/build-detail.mjs female <glb>` (needs `npm i meshoptimizer@0.21.0`).
- Browsers without WebGL2 fall back to the reduced canvas renderer without these effects.

Muscle microvessels are generated teaching geometry anchored to source muscle surfaces. The H01 cortex specimen is a separate measured dataset shared by both reference models. Case notes supplied in an atlas link are read from its fragment in the browser.
