<!--
A copy of the sentences below each requirements block of the contract pages
that name the requirements `plx doctor` checks (§ 1.3 PLX), verbatim, from
`contracts/repo.md` and `contracts/app.md` of the compendium. doctor.test.ts
holds the names in them equal to the names CHECKS carries; with PLX_COMPENDIUM
set to a compendium checkout it reads the pages themselves instead.
-->

`plx doctor` checks `PLX-Repo/Marker`.

`plx doctor` checks of `PLX-Repo/Verbs` that `dev`, `build` and `verify` exist as root mise tasks, and of `PLX-Repo/SubVerbs` that `lint`, `check`, `test` and `verify` do, not what they run, in which order, or whether they pass.

`plx doctor` checks `PLX-App/Marker`.

`plx doctor` checks of `PLX-App/Compose` that `docker/compose.yaml` exists and declares the app service, and of `PLX-App/TenantLabel` that every service carries a `plexus.tenant` label with a value, not that the value is the tenant's slug.

`plx doctor` checks `PLX-App/EnvFileLoad` on the app service, `PLX-App/ImageRef` for a built app, and of `PLX-App/NoCommittedValues` that the source repo tracks no `.env` and no `.env.secret`.

`plx doctor` checks of `PLX-App/SinglePort` that the app service publishes exactly one port, not that it speaks plain HTTP, and checks `PLX-App/LoopbackPort`.

`plx doctor` checks of `PLX-App/Healthcheck` that the app service declares a `healthcheck` with a test of its own that is not disabled.

`plx doctor` checks of `PLX-App/Dockerfile` that a built app has the file.

`plx doctor` checks `PLX-App/Stateless/NoState`.

`plx doctor` checks of `PLX-App/Stateful/MigrateService` that a `migrate` service under `profiles: ["migrate"]` runs on the app service's image.

`plx doctor` checks of `PLX-App/Stateful/Seed`, where the app is a JS app, that its `package.json` has a `seed` script.
