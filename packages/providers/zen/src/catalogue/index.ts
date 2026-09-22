/**
 * `@namzu/zen/catalogue`: derive the Zen and Go roster at run time.
 *
 * Opt-in. Nothing here runs unless called, and only `fetchZenCatalogue` and
 * `fetchZenCatalogueSources` touch the network. A host that wants a fresher
 * roster than the bundled snapshot calls `fetchZenCatalogue()`, stores the
 * result if it likes, and hands it to `ZenProvider` through
 * `ZenConfig.catalogue`.
 *
 * The parsing rules themselves (`./derive.js`) are not part of this subpath:
 * they are shared with the repository's snapshot generator, which imports the
 * built module directly, and are free to change shape between releases.
 */

export {
	type BuildZenCatalogueOptions,
	ZEN_CATALOGUE_VERSION,
	type ZenCatalogue,
	ZenCatalogueFormatError,
	type ZenCatalogueReport,
	type ZenCatalogueResult,
	type ZenCatalogueSources,
	buildZenCatalogue,
	findZenCatalogueModel,
	isUnroutedZenModel,
	parseZenCatalogue,
} from './catalogue.js'
export { ZenCatalogueSourceError, type ZenOmissions } from './derive.js'
export {
	type FetchZenCatalogueOptions,
	ZEN_DOCS_REF,
	ZEN_MODELS_DEV_URL,
	ZEN_SERVICE_BASE,
	type ZenCatalogueLimits,
	fetchZenCatalogue,
	fetchZenCatalogueSources,
} from './fetch.js'
