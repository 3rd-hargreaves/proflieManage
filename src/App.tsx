import MainPage from './pages/MainPage'
import EditPage from './pages/EditPage'

export default function App() {
  const path = window.location.pathname.replace(/\/$/, '')
  if (path === '/edit' || path === '/manage.html') return <EditPage />
  return <MainPage />
}
