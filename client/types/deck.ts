import { Flashcard } from './flashcard';

export interface Deck {
  id: string;
  name: string;
  flashcards: Flashcard[];
  notes: string;
}
