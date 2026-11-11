/**
 * The size of the bundled Pal computer image, the one figure the setup card and the docs share
 * (`docs/sdk/local-pal-computer.md` gives it as 1,200,803,328 bytes). A test compares this with the
 * page, so a rebuilt image that changes the page changes this too.
 */
export const PAL_COMPUTER_IMAGE_BYTES = 1_200_803_328

/** "about 1.2 GB": a rounded, decimal figure for a person deciding about disk space. */
export function palComputerImageSize(bytes: number = PAL_COMPUTER_IMAGE_BYTES): string {
	return `about ${(bytes / 1e9).toFixed(1)} GB`
}
