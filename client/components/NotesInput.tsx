import React, { useState, useEffect } from 'react';
import styles from '../styles/NotesInput.module.scss';

interface NotesInputProps {
  deckId: string;
  initialNotes: string;
  onNotesUpdate: (updatedNotes: string) => void;
  onFlashcardsGenerated: (newFlashcards: any[]) => void;
}

const NotesInput: React.FC<NotesInputProps> = ({ deckId, initialNotes, onNotesUpdate, onFlashcardsGenerated }) => {
  const [notes, setNotes] = useState(initialNotes);
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    setNotes(initialNotes);
    setHasChanges(false);
  }, [initialNotes, deckId]);

  const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNotes(e.target.value);
    setHasChanges(e.target.value !== initialNotes);
  };

  const handleSaveNotes = async () => {
    onNotesUpdate(notes);
    setHasChanges(false);
  };

  const handleGenerateFlashcards = async () => {
    setIsGenerating(true);
    try {
      const response = await fetch(`/api/decks/${deckId}/generate-flashcards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      });
      if (response.ok) {
        const newFlashcards = await response.json();
        onFlashcardsGenerated(newFlashcards);
      }
    } catch (error) {
      console.error('Failed to generate flashcards:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className={styles.notesInput}>
      <h2>Notes</h2>
      <textarea
        value={notes}
        onChange={handleNotesChange}
        placeholder="Enter your notes here..."
      />
      <div className={styles.buttonGroup}>
        <button 
          onClick={handleSaveNotes}
          className={hasChanges ? styles.saveButtonHighlighted : ''}
          disabled={!hasChanges}
        >
          Save Notes
        </button>
        <button 
          onClick={handleGenerateFlashcards} 
          disabled={!notes.trim() || isGenerating}
        >
          {isGenerating ? 'Generating...' : 'Generate Flashcards'}
        </button>
      </div>
      {isGenerating && <div className={styles.loadingIndicator}>Generating flashcards...</div>}
    </div>
  );
};

export default NotesInput;