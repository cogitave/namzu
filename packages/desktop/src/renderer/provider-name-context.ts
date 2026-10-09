import { createContext } from 'react'

/** The name a person knows the active provider by, for lines such as "Waiting for … to accept more requests". */
export const ProviderNameContext = createContext('the provider')
