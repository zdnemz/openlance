import { Google, GitHub, LinkedIn } from 'arctic'

// Placeholder for OAuth configs - in a real app these come from env
// Using non-empty strings to avoid initial crashes if env vars are missing during dev
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'mock_id'
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'mock_secret'
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3002/auth/login/google/callback'

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'mock_id'
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || 'mock_secret'

const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID || 'mock_id'
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET || 'mock_secret'
const LINKEDIN_REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI || 'http://localhost:3002/auth/login/linkedin/callback'

export const google = new Google(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)
export const github = new GitHub(GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET)
// Note: Arctic might have specific imports for LinkedIn or generic OAuth2. 
// Checking arctic docs or assuming standard OAuth2 for LinkedIn if specific class not found. 
// For now assuming LinkedIn class exists or using generic if needed. 
// Actually Arctic supports LinkedIn.
export const linkedin = new LinkedIn(LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_REDIRECT_URI)
