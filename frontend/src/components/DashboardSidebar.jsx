import { NavLink } from "react-router-dom";

const DashboardSidebar = ({ links, user, onLogout }) => {
  return (
    <aside className="dashboard-sidebar">
      <div className="dashboard-sidebar__header">
        <span className="dashboard-sidebar__brand">Crime Hotspot &amp; Predictive</span>
        <span className="dashboard-sidebar__welcome">Hi, {user?.name || "Officer"}</span>
      </div>
      <nav className="dashboard-sidebar__nav" aria-label="Dashboard navigation">
        {links.map((link) => (
          <NavLink
            key={link.label}
            to={link.to}
            end={link.to === "."}
            className={({ isActive }) =>
              isActive ? "dashboard-sidebar__link dashboard-sidebar__link--active" : "dashboard-sidebar__link"
            }
          >
            <span className="dashboard-sidebar__link-text">{link.label}</span>
          </NavLink>
        ))}
      </nav>
      <button type="button" className="dashboard-sidebar__logout" onClick={() => onLogout?.()}>
        Logout
      </button>
    </aside>
  );
};

export default DashboardSidebar;
