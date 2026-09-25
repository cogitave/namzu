/**
 * Route a front door's compatible options without another hand-written copy
 * of every assignment. The route table is checked against the front door's
 * complete option type at its declaration site.
 */
export function pickRoutedOptions<
	TOptions extends object,
	TRoutes extends { readonly [K in keyof TOptions]: 'query' | 'turn' | 'special' },
	TDestination extends 'query' | 'turn',
>(
	options: TOptions,
	routes: TRoutes,
	destination: TDestination,
): Pick<
	TOptions,
	Extract<
		{
			[K in keyof TRoutes]: TRoutes[K] extends TDestination ? K : never
		}[keyof TRoutes],
		keyof TOptions
	>
> {
	const picked: Record<string, unknown> = {}
	for (const key of Object.keys(routes) as (keyof TOptions & string)[]) {
		const route: 'query' | 'turn' | 'special' = routes[key]
		if (route === destination && options[key] !== undefined) picked[key] = options[key]
	}
	return picked as Pick<
		TOptions,
		Extract<
			{
				[K in keyof TRoutes]: TRoutes[K] extends TDestination ? K : never
			}[keyof TRoutes],
			keyof TOptions
		>
	>
}
