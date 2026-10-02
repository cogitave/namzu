import { z } from 'zod'
import { activityCursorSchema, activityScopeSchema } from '../communication/ingress-schema.js'
import { addressSchema } from '../communication/schema.js'

const positive = z.number().int().positive().safe()
export const subscriptionScopeSchema = activityScopeSchema
export const subscriptionCursorSchema = activityCursorSchema
const subscriptionObjectSchema = z
	.object({
		v: z.literal(1),
		id: z.string().uuid(),
		revision: positive,
		configurationRevision: positive,
		scope: subscriptionScopeSchema,
		recipient: addressSchema,
		enabled: z.boolean(),
		cursor: subscriptionCursorSchema.nullable(),
	})
	.strict()
export const subscriptionSchema = subscriptionObjectSchema.refine(
	(v) => v.scope.tenantId === v.recipient.tenantId,
	'Cross-tenant observation is refused.',
)
export const storedSubscriptionSchema = subscriptionObjectSchema
	.extend({ schemaVersion: z.literal(1).optional() })
	.transform(({ schemaVersion: _schemaVersion, ...value }) => value)
	.pipe(subscriptionSchema)
