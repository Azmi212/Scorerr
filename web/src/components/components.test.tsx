import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { Button, Dialog, FieldLabel, FormField, Input, SecretInput, Select, Switch } from './index';

describe('generic design-system controls', () => {
  it('supports button loading and disabled states', () => {
    render(
      <>
        <Button loading>Enregistrer</Button>
        <Button disabled>Indisponible</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Chargement' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Indisponible' })).toBeDisabled();
  });

  it('connects labels, helper text and errors to inputs', () => {
    render(
      <FormField helperText="Aide" error="Champ requis">
        <FieldLabel>Nom</FieldLabel>
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText('Nom');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain('helper');
    expect(input.getAttribute('aria-describedby')).toContain('error');
    expect(screen.getByRole('alert')).toHaveTextContent('Champ requis');
  });

  it('masks a secret by default and reveals it only on request', async () => {
    const user = userEvent.setup();
    render(
      <FormField>
        <FieldLabel>Clé API</FieldLabel>
        <SecretInput defaultValue="secret-local" />
      </FormField>,
    );
    const input = screen.getByLabelText('Clé API');
    expect(input).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Afficher la valeur' }));
    expect(input).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Masquer la valeur' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('provides an accessible select with placeholder and error state', () => {
    render(
      <FormField error="Choix requis">
        <FieldLabel>Langue</FieldLabel>
        <Select defaultValue="">
          <option value="" disabled>
            Sélectionner
          </option>
          <option value="fr">Français</option>
        </Select>
      </FormField>,
    );
    expect(screen.getByLabelText('Langue')).toHaveValue('');
    expect(screen.getByLabelText('Langue')).toHaveAttribute('aria-invalid', 'true');
  });

  it('changes a switch with keyboard interaction', async () => {
    const user = userEvent.setup();
    function Example() {
      const [checked, setChecked] = useState(false);
      return (
        <Switch checked={checked} onCheckedChange={setChecked} aria-label="Serveur par défaut" />
      );
    }
    render(<Example />);
    const control = screen.getByRole('switch', { name: 'Serveur par défaut' });
    control.focus();
    await user.keyboard('[Space]');
    expect(control).toHaveAttribute('aria-checked', 'true');
  });

  it('closes a dialog with Escape and restores focus', async () => {
    const user = userEvent.setup();
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button
            onClick={() => {
              setOpen(true);
            }}
          >
            Supprimer
          </Button>
          <Dialog
            open={open}
            title="Supprimer le profil"
            destructive
            onClose={() => {
              setOpen(false);
            }}
          />
        </>
      );
    }
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'Supprimer' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
