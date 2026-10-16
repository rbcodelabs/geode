import { installParserWorker, type ParserWorkerScope } from "./parser-worker";
installParserWorker(self as unknown as ParserWorkerScope);
