import { Link } from 'react-router-dom';

interface PlaceholderPageProps {
  title: string;
  description: string;
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <section className="page" aria-labelledby="page-title">
      <header className="page-header">
        <h1 id="page-title">{title}</h1>
        <p>{description}</p>
      </header>
      <div className="page-placeholder" role="note">
        <span>Structure prête</span>
        <p>Le contenu fonctionnel sera ajouté dans une phase dédiée.</p>
      </div>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section className="page not-found" aria-labelledby="not-found-title">
      <p className="eyebrow">404</p>
      <h1 id="not-found-title">Page introuvable</h1>
      <p>Cette destination n’existe pas dans scorerr.</p>
      <Link className="button button-primary" to="/">
        Retour au Dashboard
      </Link>
    </section>
  );
}
