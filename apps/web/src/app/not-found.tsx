import Link from "next/link";

export default function NotFound() {
  return (
    <div className="tm-view">
      <div className="tm-full">
        <div>
          <h1>Page not found</h1>
          <p className="tm-muted">The link may be out of date.</p>
          <Link className="tm-btn tm-btn-line" href="/">
            Go to the overview
          </Link>
        </div>
      </div>
    </div>
  );
}
