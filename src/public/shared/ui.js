import { h } from './dom.js';

export function toast(message, kind = '') {
  let stack = document.querySelector('.toasts');
  if (!stack) {
    stack = h('div', { class: 'toasts', role: 'status' });
    document.body.append(stack);
  }
  const item = h('div', { class: `toast ${kind}` }, message);
  stack.append(item);
  setTimeout(() => item.remove(), kind === 'error' ? 6000 : 3000);
}

/** Resolves true when the person confirms, false when they cancel or press Esc. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let confirmed = false;
    const dialog = h('dialog', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', null, title)),
      h('div', { class: 'modal-body' }, [].concat(message).map((line) => h('p', null, line))),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        h('button', {
          class: `btn ${danger ? 'danger solid' : 'primary'}`,
          type: 'button',
          onclick: () => {
            confirmed = true;
            dialog.close();
          },
        }, confirmLabel),
      ),
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(confirmed);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function buildControl(field, value) {
  switch (field.type) {
    case 'textarea': {
      const element = h('textarea', { rows: field.rows || 3, required: field.required });
      element.value = value == null ? '' : value;
      return { element, read: () => element.value };
    }
    // One entry per line, read back as an array.
    case 'lines': {
      const element = h('textarea', { rows: field.rows || 5, required: field.required });
      element.value = (value || []).join('\n');
      return { element, read: () => element.value.split('\n').map((line) => line.trim()).filter(Boolean) };
    }
    case 'select': {
      const element = h('select', null, field.options.map((option) => h('option', { value: option.value }, option.label)));
      if (value != null) element.value = value;
      return { element, read: () => element.value };
    }
    case 'checkbox': {
      const input = h('input', { type: 'checkbox', checked: Boolean(value) });
      return { element: h('label', { class: 'check' }, input, field.text), read: () => input.checked };
    }
    // A list of checkboxes, read back as the array of ticked values.
    case 'checks': {
      const picked = new Set(value || []);
      const inputs = field.options.map((option) => ({
        option,
        input: h('input', { type: 'checkbox', checked: picked.has(option.value) }),
      }));
      const element = h('div', { class: 'checks' },
        inputs.map(({ option, input }) => h('label', { class: 'check' }, input, option.label)));
      return { element, read: () => inputs.filter(({ input }) => input.checked).map(({ option }) => option.value) };
    }
    default: {
      const element = h('input', {
        type: field.type === 'password' ? 'password' : 'text',
        inputMode: field.type === 'number' ? 'decimal' : undefined,
        required: field.required,
        placeholder: field.placeholder,
        autocomplete: 'off',
      });
      element.value = value == null ? '' : value;
      return { element, read: () => element.value.trim() };
    }
  }
}

/**
 * Modal form. `fields` is a list of { name, label, type, hint, required, ... }; false entries are skipped.
 * `onSubmit(values)` may throw; the message is shown and the dialog stays open.
 * Resolves true once saved, false if cancelled.
 */
export function formDialog({ title, intro, fields, values = {}, submitLabel = 'Save', onSubmit }) {
  return new Promise((resolve) => {
    let saved = false;
    // A field given as false is left out, so a dialog can show some fields only when editing.
    const controls = fields.filter(Boolean).map((field) => ({ field, ...buildControl(field, values[field.name]) }));
    const error = h('p', { class: 'form-error', hidden: true });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);

    const form = h('form', {
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        error.hidden = true;
        try {
          await onSubmit(Object.fromEntries(controls.map((control) => [control.field.name, control.read()])));
          saved = true;
          dialog.close();
        } catch (failure) {
          error.textContent = failure.message;
          error.hidden = false;
          submit.disabled = false;
        }
      },
    },
      h('div', { class: 'modal-head' }, h('h2', null, title)),
      h('div', { class: 'modal-body' },
        intro && h('p', { class: 'muted' }, intro),
        error,
        controls.map(({ field, element }) => h('div', { class: 'field' },
          h('span', { class: 'field-label' }, field.label),
          element,
          field.hint && h('span', { class: 'field-hint' }, field.hint),
        )),
      ),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        submit,
      ),
    );

    const dialog = h('dialog', { class: 'modal' }, form);
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(saved);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
