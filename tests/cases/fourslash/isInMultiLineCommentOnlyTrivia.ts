/// <reference path="fourslash.ts" />

//// /* x */
//// /**
////   * @param this doesn't make sense here.
////   */
//// // x

const firstCommentStart = 0;
const firstCommentEnd = 7;
goTo.position(firstCommentStart);
verify.not.isInCommentAtPosition(/*onlyMultiLine*/ true);

goTo.position(firstCommentStart + 1);
verify.isInCommentAtPosition(/*onlyMultiLine*/ true);
goTo.position(firstCommentEnd - 1);
verify.isInCommentAtPosition(/*onlyMultiLine*/ true);

goTo.position(firstCommentEnd);
verify.not.isInCommentAtPosition(/*onlyMultiLine*/ true);

const multilineJsDocStart = firstCommentEnd + 1;
const multilineJsDocEnd = multilineJsDocStart + 49;

goTo.position(multilineJsDocStart);
verify.not.isInCommentAtPosition(/*onlyMultiLine*/ true);
goTo.position(multilineJsDocStart + 1);
verify.isInCommentAtPosition(/*onlyMultiLine*/ true);
goTo.position(multilineJsDocEnd - 1);
verify.isInCommentAtPosition(/*onlyMultiLine*/ true);
goTo.position(multilineJsDocEnd);
verify.not.isInCommentAtPosition(/*onlyMultiLine*/ true);

const singleLineCommentStart = multilineJsDocEnd + 1;

goTo.position(singleLineCommentStart + 1);
verify.not.isInCommentAtPosition(/*onlyMultiLine*/ true);
verify.isInCommentAtPosition(/*onlyMultiLine*/ false);