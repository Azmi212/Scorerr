import { useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  FieldLabel,
  FormField,
  Input,
  SecretInput,
  Select,
  Skeleton,
  Spinner,
  Switch,
} from '../components';

export function DesignSystemPage() {
  const [checked, setChecked] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <section className="page design-system" aria-labelledby="page-title">
      <header className="page-header">
        <p className="eyebrow">Développement</p>
        <h1 id="page-title">Design system</h1>
        <p>Inventaire technique des composants génériques.</p>
      </header>
      <Card className="component-grid">
        <div>
          <h2>Boutons</h2>
          <div className="component-row">
            <Button>Principal</Button>
            <Button variant="secondary">Secondaire</Button>
            <Button variant="ghost">Discret</Button>
            <Button variant="destructive">Destructif</Button>
            <Button loading>Chargement</Button>
          </div>
        </div>
        <div>
          <h2>Champs</h2>
          <div className="component-row component-fields">
            <FormField helperText="Texte d’aide">
              <FieldLabel>Nom</FieldLabel>
              <Input placeholder="Nom du serveur" />
            </FormField>
            <FormField error="Valeur incorrecte">
              <FieldLabel>Clé secrète</FieldLabel>
              <SecretInput defaultValue="valeur-de-demonstration" />
            </FormField>
            <FormField>
              <FieldLabel>Langue</FieldLabel>
              <Select defaultValue="fr">
                <option value="fr">Français</option>
                <option value="en">Anglais</option>
              </Select>
            </FormField>
          </div>
        </div>
        <div>
          <h2>États</h2>
          <div className="component-row">
            <Switch checked={checked} onCheckedChange={setChecked} aria-label="Option active" />
            <Badge>Neutre</Badge>
            <Badge variant="info">Info</Badge>
            <Badge variant="success">Succès</Badge>
            <Badge variant="warning">Attention</Badge>
            <Badge variant="error">Erreur</Badge>
            <Spinner />
            <Skeleton style={{ width: 160, height: 36 }} />
          </div>
        </div>
        <div>
          <h2>Alertes</h2>
          <div className="component-stack">
            <Alert variant="info" title="Information" />
            <Alert variant="success" title="Opération réussie" />
            <Alert variant="warning" title="Vérification nécessaire" />
            <Alert variant="error" title="Une erreur est survenue" />
          </div>
        </div>
        <div>
          <h2>Dialogue</h2>
          <Button
            onClick={() => {
              setDialogOpen(true);
            }}
          >
            Ouvrir le dialogue
          </Button>
        </div>
      </Card>
      <Dialog
        open={dialogOpen}
        title="Confirmer l’action"
        description="Cette démonstration ne modifie aucune donnée."
        destructive
        confirmLabel="Confirmer"
        onClose={() => {
          setDialogOpen(false);
        }}
        onConfirm={() => {
          setDialogOpen(false);
        }}
      />
    </section>
  );
}
