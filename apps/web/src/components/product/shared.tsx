"use client";
import { LoaderCircle } from "lucide-react";
export function Pending() {
  return (
    <div className="product-empty">
      <LoaderCircle className="spin" size={24} /> Loading workspace records…
    </div>
  );
}
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}
