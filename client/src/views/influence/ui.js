export const card = {
  background: '#16181d',
  border: '1px solid #26282f',
  borderRadius: 10,
  padding: '16px 20px',
  marginBottom: 18,
}

export const muted = { color: '#a1a1aa' }

export function navigate(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
