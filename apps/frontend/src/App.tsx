import { Routes, Route, Link } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import AuditHistory from './pages/AuditHistory';
import StandardsList from './pages/StandardsList';
import Settings from './pages/Settings';

function App() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Navbar */}
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center gap-8">
              <Link to="/" className="text-xl font-bold text-indigo-600">
                AI Code Governance
              </Link>
              <div className="hidden sm:flex gap-6">
                <Link
                  to="/"
                  className="text-sm font-medium text-gray-600 hover:text-gray-900"
                >
                  Dashboard
                </Link>
                <Link
                  to="/audits"
                  className="text-sm font-medium text-gray-600 hover:text-gray-900"
                >
                  Audit History
                </Link>
                <Link
                  to="/standards"
                  className="text-sm font-medium text-gray-600 hover:text-gray-900"
                >
                  Standards
                </Link>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Link
                to="/settings"
                className="text-sm font-medium text-gray-500 hover:text-gray-700"
              >
                Settings
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/audits" element={<AuditHistory />} />
          <Route path="/standards" element={<StandardsList />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200 py-4">
        <div className="max-w-7xl mx-auto px-4 text-center text-sm text-gray-500">
          AI Code Governance Platform — Governing the requirement→task→code pipeline
        </div>
      </footer>
    </div>
  );
}

export default App;
