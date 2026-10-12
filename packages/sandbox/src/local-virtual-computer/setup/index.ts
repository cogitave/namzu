/**
 * Windows Pal computer setup: inspect the machine, plan, and run the plan
 * after the person agrees. Separate from the provider, which never installs,
 * loads or starts anything.
 */
export * from './contract.js'
export { createWslcSetupHost } from './host.js'
export { stopIdleWslcSession } from './idle.js'
export { loadWslcImage } from './image.js'
export { planWslcSetup } from './plan.js'
export { inspectWslcReadiness } from './readiness.js'
export { clearRestartMarker, readRestartMarker, writeRestartMarker } from './restart.js'
export { clearResumeAtSignIn, registerResumeAtSignIn } from './resume.js'
export { runWslcSetup } from './run.js'
export { runElevatedWslcSteps } from './elevated.js'
export { downloadWslPackage, PINNED_WSL_PACKAGE } from './wsl-package.js'
