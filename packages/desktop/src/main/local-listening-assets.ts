/**
 * Immutable inputs for local listening, verified against the model host's and the release
 * host's own metadata. A byte count or digest that no longer matches is a damaged download.
 */
export const LISTENING_MODEL_REPOSITORY = 'csukuangfj/sherpa-onnx-whisper-turbo'
export const LISTENING_MODEL_REVISION = '2ca6ff69fc878651b770880507669577ac41c2ff'
const MODEL_BASE = `https://huggingface.co/${LISTENING_MODEL_REPOSITORY}/resolve/${LISTENING_MODEL_REVISION}`

export interface ListeningAsset {
	/** File name inside the models directory; also the key the worker looks up. */
	name: string
	role: 'encoder' | 'decoder' | 'tokens' | 'voiceActivity'
	url: string
	bytes: number
	sha256: string
}

export const LISTENING_ASSETS: readonly ListeningAsset[] = [
	{
		name: 'turbo-encoder.int8.onnx',
		role: 'encoder',
		url: `${MODEL_BASE}/turbo-encoder.int8.onnx`,
		bytes: 674_716_297,
		sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b',
	},
	{
		name: 'turbo-decoder.int8.onnx',
		role: 'decoder',
		url: `${MODEL_BASE}/turbo-decoder.int8.onnx`,
		bytes: 361_080_764,
		sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547',
	},
	{
		name: 'turbo-tokens.txt',
		role: 'tokens',
		url: `${MODEL_BASE}/turbo-tokens.txt`,
		bytes: 816_730,
		sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126',
	},
	{
		name: 'silero_vad.onnx',
		role: 'voiceActivity',
		url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
		bytes: 643_854,
		sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
	},
]

/** Everything the one-time download fetches. */
export const LISTENING_DOWNLOAD_BYTES = LISTENING_ASSETS.reduce(
	(sum, asset) => sum + asset.bytes,
	0,
)

/** Recognition settings. Turkish only, as the speech output is. */
export const LISTENING_LANGUAGE = 'tr'
export const LISTENING_THREADS = 4
