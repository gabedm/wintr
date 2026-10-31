import type { DocumentReference, Firestore } from '@google-cloud/firestore';
import type { FirestoreLike } from './docstore.js';

// Compile-time proof (type-only; nothing is imported or constructed at runtime,
// so no credential lookup can happen): the official server SDK's Firestore
// client satisfies the structural surface createFirestoreDocStore uses. If an
// SDK upgrade changes that surface, typecheck fails here.
export const sdkFirestoreSatisfiesAdapter = (db: Firestore): FirestoreLike<DocumentReference> => db;
/** Same public surface plus the SDK's supported lifecycle method for an exclusive owner. */
export const sdkOwnedFirestoreSatisfiesAdapter = (db: Firestore): FirestoreLike<DocumentReference> & { terminate(): Promise<void> } => db;
