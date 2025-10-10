import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const Navbar = () => {
  const { isAuthenticated } = useAuth();

  if (isAuthenticated) {
    return null;
  }

  return (
    <header className="navbar">
      <Link className="navbar__brand" to="/">
        Crime Hotspot and Predictive Model
      </Link>
      <nav className="navbar__links">
        <Link to="/login" className="navbar__action">
          Login
        </Link>
        <Link to="/signup" className="navbar__action navbar__action--primary">
          Sign Up
        </Link>
      </nav>
    </header>
  );
};

export default Navbar;
