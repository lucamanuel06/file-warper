import styles from './TitleBar.module.css';

export function TitleBar() {
  return (
    <div className={styles.titlebar} data-testid="titlebar">
      <span className={styles.title}>File Warper</span>
    </div>
  );
}
