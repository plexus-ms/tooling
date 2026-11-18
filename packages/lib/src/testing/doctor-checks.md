<!--
A copy of the sentences below each requirements block of the contract pages
that name the requirements `plx doctor` checks (§ 1.3 PLX), verbatim, from
`contracts/repo.md` and `contracts/app.md` of the compendium. doctor.test.ts
holds the names in them equal to the names CHECKS carries; with PLX_COMPENDIUM
set to a compendium checkout it reads the pages themselves instead.
-->

`plx doctor` checks `PLX-Repo/Marker`.

`plx doctor` checks `PLX-Repo/Verbs` and `PLX-Repo/SubVerbs`.

`plx doctor` checks `PLX-App/Marker`.

`plx doctor` checks `PLX-App/Compose` and `PLX-App/TenantLabel`.

`plx doctor` checks `PLX-App/EnvFileLoad`, `PLX-App/ImageRef` for a built app, and of `PLX-App/NoCommittedValues` that the source repo tracks no `.env` and no `.env.secret`.

`plx doctor` checks `PLX-App/SinglePort` and `PLX-App/LoopbackPort`.

`plx doctor` checks of `PLX-App/Healthcheck` that the app service declares a `healthcheck`.

`plx doctor` checks of `PLX-App/Dockerfile` that a built app has the file.

`plx doctor` checks `PLX-App/Stateless/NoState`.

`plx doctor` checks `PLX-App/Stateful/MigrateService`.

`plx doctor` checks of `PLX-App/Stateful/Seed`, where the app is a JS app, that its `package.json` has a `seed` script.
