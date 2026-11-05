import { createContext, useContext } from 'react'

export const BaselineName = createContext('Codex')

export const useBaselineName = () => useContext(BaselineName)
