import { Icon } from './Icons';

export function Footer() {
  return (
    <footer className="foot">
      <p><Icon name="shield" size={16} /> Only download content you own or have permission to save.</p>
      <p>Grab runs on your own computer.</p>
    </footer>
  );
}