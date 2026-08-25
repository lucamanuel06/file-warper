'use client';

import { DropZone } from '@ui/components/DropZone/DropZone';
import { ErrorBanner } from '@ui/components/ErrorBanner/ErrorBanner';
import { FileList } from '@ui/components/FileList/FileList';
import { Footer } from '@ui/components/Footer/Footer';
import { OptionsDisclosure } from '@ui/components/OptionsDisclosure/OptionsDisclosure';
import { TitleBar } from '@ui/components/TitleBar/TitleBar';
import { installMockBridge } from '@ui/mockBridge';
import { useWarpApp } from '@ui/useWarpApp';
import { buildTargetGroups } from '@ui/utils/targetGroups';
import styles from './page.module.css';

installMockBridge();

export default function Page() {
  const app = useWarpApp();
  const targetGroups = buildTargetGroups(app.targetSet, app.target);

  return (
    <div className={styles.window}>
      <TitleBar />
      <main className={styles.content} data-testid="content">
        {app.environmentIssue && <ErrorBanner issue={app.environmentIssue} />}
        {app.phase === 'empty' ? (
          <DropZone
            dragActive={app.dragActive}
            onClick={() => void app.browse()}
            onDragOver={app.handleDragOver}
            onDragLeave={app.handleDragLeave}
            onDrop={app.handleDrop}
          />
        ) : (
          <FileList
            files={app.files}
            phase={app.phase}
            willConvertCount={app.willConvertCount}
            dragActive={app.dragActive}
            onClear={app.clear}
            onRemove={(id) => void app.removeFile(id)}
            onReveal={app.revealFile}
            onToggleExpand={app.toggleExpand}
            onCopyDetails={app.copyDetails}
            onDragOver={app.handleDragOver}
            onDragLeave={app.handleDragLeave}
            onDrop={app.handleDrop}
          />
        )}
      </main>

      {app.phase !== 'empty' && (
        <>
          <div className={styles.optionsRow}>
            <OptionsDisclosure
              expanded={app.optionsExpanded}
              disabled={app.phase !== 'staged'}
              category={app.targetCategory}
              targetDef={app.targetDef}
              values={app.optionValues}
              saveLocation={app.saveLocation}
              onToggle={app.toggleOptions}
              onChange={app.updateOption}
              onChooseFolder={() => void app.chooseFolder()}
              onRevertSaveLocation={app.revertSaveLocation}
            />
          </div>
          <Footer
            phase={app.phase}
            target={app.target}
            targetGroups={targetGroups}
            onTargetChange={app.changeTarget}
            willConvertCount={app.willConvertCount}
            totalCount={app.files.length}
            statusText={app.statusText}
            overallProgress={app.overallProgress}
            hasFailed={app.hasFailed}
            onConvert={() => void app.convert()}
            onCancel={app.cancel}
            onDone={app.done}
            onRevealAll={app.revealAll}
            onRetryFailed={() => void app.retryFailed()}
          />
        </>
      )}
    </div>
  );
}
